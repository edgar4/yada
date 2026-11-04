import { afterEach, expect, it, vi } from "vitest";
import {
  createMcpOAuth,
  connectMcp,
  type McpOAuthStore,
  type OAuthSession,
} from "../src/index.js";
const identity = { actorId: "a", tenantId: "t" };
function setup() {
  const records = new Map<string, OAuthSession>();
  const store: McpOAuthStore = {
    load: (key) => Promise.resolve(records.get(key)),
    update: (key, patch) => {
      records.set(key, { ...records.get(key), ...patch });
      return Promise.resolve();
    },
    consumePending: (key, state) => {
      const record = records.get(key);
      if (record?.pending?.state !== state) return Promise.resolve(undefined);
      const pending = record.pending;
      delete record.pending;
      return Promise.resolve(pending);
    },
  };
  const redirect = vi.fn(() => Promise.resolve());
  const options = {
    serverUrl: "https://mcp.example/mcp",
    redirectUrl: "https://app.example/callback",
    identity,
    store,
    redirect,
  };
  const oauth = createMcpOAuth(options);
  const seed = async () => {
    await oauth.provider.saveClientInformation?.({
      client_id: "yada-client",
      issuer: "https://auth.example",
    });
    await oauth.provider.saveDiscoveryState?.({
      authorizationServerUrl: "https://auth.example",
      authorizationServerMetadata: {
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        ...{ authorization_response_iss_parameter_supported: true },
      },
    });
  };
  const pending = async () => {
    const state = await oauth.provider.state?.();
    await oauth.provider.saveCodeVerifier("verifier");
    return new URLSearchParams({
      state: String(state),
      code: "code",
      iss: "https://auth.example",
    });
  };
  return { records, store, options, oauth, seed, pending, redirect };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("authorizes with PKCE, exchanges code, reconnects and refreshes", async () => {
  const s = setup();
  await s.seed();
  let token = "";
  const grants: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://auth.example/token") {
        const params = new URLSearchParams(
          typeof init?.body === "string" ||
            init?.body instanceof URLSearchParams
            ? init.body
            : "",
        );
        grants.push(params.get("grant_type") ?? "");
        if (grants.length === 1) {
          expect(params.get("code_verifier")).toBeTruthy();
          expect(params.get("code")).toBe("code");
        }
        token = `access-${String(grants.length)}`;
        return Promise.resolve(
          Response.json({
            access_token: token,
            refresh_token: "refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      }
      if (init?.method === "GET")
        return Promise.resolve(new Response(null, { status: 405 }));
      if (
        !token ||
        new Headers(init?.headers).get("authorization") !== `Bearer ${token}`
      )
        return Promise.resolve(new Response(null, { status: 401 }));
      const request = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as { id?: number; method?: string };
      if (request.id === undefined)
        return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(
        Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "initialize"
              ? {
                  protocolVersion: "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "test", version: "1" },
                }
              : {
                  tools: [{ name: "lookup", inputSchema: { type: "object" } }],
                },
        }),
      );
    }),
  );
  const config = {
    name: "remote",
    url: s.options.serverUrl,
    readTools: ["lookup"],
  };
  const access = { identity, authorize: () => Promise.resolve(true) };
  await expect(
    connectMcp(config, access, AbortSignal.timeout(2000), s.oauth),
  ).rejects.toThrow();
  expect(s.redirect).toHaveBeenCalledOnce();
  const state = [...s.records.values()][0]?.pending?.state;
  await s.oauth.complete(
    new URLSearchParams({
      state: String(state),
      code: "code",
      iss: "https://auth.example",
    }),
  );
  const connection = await connectMcp(
    config,
    access,
    AbortSignal.timeout(2000),
    s.oauth,
  );
  await connection.close();
  token = "expired";
  const refreshed = await connectMcp(
    config,
    access,
    AbortSignal.timeout(2000),
    s.oauth,
  );
  await refreshed.close();
  expect(grants).toEqual(["authorization_code", "refresh_token"]);
  expect((await s.oauth.provider.tokens())?.issuer).toBe(
    "https://auth.example",
  );
});
it.each([
  "missing",
  "wrong",
  "expired",
  "issuer",
  "denied",
  "no-code",
  "duplicate",
])("rejects invalid callback: %s", async (kind) => {
  const s = setup();
  await s.seed();
  const params = await s.pending();
  if (kind === "missing") params.delete("state");
  if (kind === "wrong") params.set("state", "wrong");
  if (kind === "expired") {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 700_000);
  }
  if (kind === "issuer") params.set("iss", "https://evil.example");
  if (kind === "denied") params.set("error", "access_denied");
  if (kind === "no-code") params.delete("code");
  if (kind === "duplicate") params.append("code", "second");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(s.oauth.complete(params)).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
it("consumes callbacks once even on exchange failure", async () => {
  const s = setup();
  await s.seed();
  const params = await s.pending();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("secret", { status: 500 }))),
  );
  await expect(s.oauth.complete(params)).rejects.toThrow(
    "OAuth token exchange failed",
  );
  await expect(s.oauth.complete(params)).rejects.toThrow("Invalid or expired");
});
it("isolates actors and rejects mismatched MCP connections", async () => {
  const s = setup();
  await s.oauth.provider.saveTokens({
    access_token: "secret",
    token_type: "Bearer",
    issuer: "https://auth.example",
  });
  const other = createMcpOAuth({
    ...s.options,
    identity: { ...identity, actorId: "b" },
  });
  expect(await other.provider.tokens()).toBeUndefined();
  await expect(
    connectMcp(
      { name: "r", url: s.options.serverUrl, readTools: ["lookup"] },
      {
        identity: { ...identity, actorId: "b" },
        authorize: () => Promise.resolve(true),
      },
      AbortSignal.timeout(1000),
      s.oauth,
    ),
  ).rejects.toThrow("mismatch");
});
it("revokes tokens at the advertised endpoint on disconnect, best effort", async () => {
  const s = setup();
  await s.seed();
  const discovery = await s.oauth.provider.discoveryState?.();
  await s.oauth.provider.saveDiscoveryState?.({
    authorizationServerUrl: "https://auth.example",
    ...discovery,
    authorizationServerMetadata: {
      ...discovery?.authorizationServerMetadata,
      revocation_endpoint: "https://auth.example/revoke",
    } as never,
  });
  await s.oauth.provider.saveTokens({
    access_token: "access",
    refresh_token: "refresh",
    token_type: "Bearer",
  });
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.reject(new Error("unavailable")),
  );
  vi.stubGlobal("fetch", fetchMock);
  await s.oauth.disconnect();
  expect(await s.oauth.provider.tokens()).toBeUndefined();
  expect(
    fetchMock.mock.calls.map(([url, init]) => [
      url,
      Object.fromEntries(init?.body as URLSearchParams),
    ]),
  ).toEqual([
    [
      "https://auth.example/revoke",
      {
        token: "refresh",
        token_type_hint: "refresh_token",
        client_id: "yada-client",
      },
    ],
    [
      "https://auth.example/revoke",
      {
        token: "access",
        token_type_hint: "access_token",
        client_id: "yada-client",
      },
    ],
  ]);
});
it.each([
  ["client_secret_basic", { authorization: "Basic aWQ6c2VjcmV0" }, {}],
  ["client_secret_post", {}, { client_id: "id", client_secret: "secret" }],
] as const)(
  "authenticates revocation with %s",
  async (method, headers, body) => {
    const s = setup();
    const oauth = createMcpOAuth({
      ...s.options,
      clientId: "id",
      clientSecret: "secret",
      clientAuthMethod: method,
    });
    await oauth.provider.saveDiscoveryState?.({
      authorizationServerUrl: "https://auth.example",
      authorizationServerMetadata: {
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        response_types_supported: ["code"],
        revocation_endpoint: "https://auth.example/revoke",
      },
    });
    await oauth.provider.saveTokens({
      access_token: "a",
      token_type: "Bearer",
    });
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null)),
    );
    vi.stubGlobal("fetch", fetchMock);
    await oauth.disconnect();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toEqual(headers);
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      token: "a",
      token_type_hint: "access_token",
      ...body,
    });
  },
);
it("authenticates revocation as the registered client was told to", async () => {
  const s = setup();
  await s.seed();
  const discovery = await s.oauth.provider.discoveryState?.();
  await s.oauth.provider.saveDiscoveryState?.({
    authorizationServerUrl: "https://auth.example",
    ...discovery,
    authorizationServerMetadata: {
      ...discovery?.authorizationServerMetadata,
      revocation_endpoint: "https://auth.example/revoke",
    } as never,
  });
  await s.oauth.provider.saveClientInformation?.({
    client_id: "id",
    client_secret: "secret",
    token_endpoint_auth_method: "client_secret_post",
  });
  await s.oauth.provider.saveTokens({
    access_token: "a",
    token_type: "Bearer",
  });
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null)),
  );
  vi.stubGlobal("fetch", fetchMock);
  await s.oauth.disconnect();
  const init = fetchMock.mock.calls[0]?.[1];
  expect(init?.headers).toEqual({});
  expect(Object.fromEntries(init?.body as URLSearchParams)).toMatchObject({
    client_id: "id",
    client_secret: "secret",
  });
});
it("does not revoke without a usable endpoint", async () => {
  const s = setup();
  await s.seed();
  await s.oauth.provider.saveTokens({
    access_token: "a",
    token_type: "Bearer",
  });
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  await s.oauth.disconnect();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await s.oauth.provider.tokens()).toBeUndefined();
});
it("invalidates credentials and disconnects locally", async () => {
  const s = setup();
  await s.seed();
  await s.pending();
  await s.oauth.provider.saveTokens({
    access_token: "secret",
    token_type: "Bearer",
  });
  await s.oauth.disconnect();
  expect(await s.oauth.provider.tokens()).toBeUndefined();
  await expect(s.oauth.provider.codeVerifier()).rejects.toThrow();
  for (const scope of [
    "client",
    "tokens",
    "discovery",
    "verifier",
    "all",
  ] as const)
    await s.oauth.provider.invalidateCredentials?.(scope);
  expect(await s.oauth.provider.clientInformation()).toBeUndefined();
  expect(await s.oauth.provider.discoveryState?.()).toBeUndefined();
});
it("requires a pending flow before saving a verifier", async () => {
  await expect(setup().oauth.provider.saveCodeVerifier("v")).rejects.toThrow();
});
it("rejects unsafe OAuth URLs", () => {
  const s = setup();
  expect(() =>
    createMcpOAuth({
      ...s.options,
      redirectUrl: "http://remote.example/callback",
    }),
  ).toThrow("Invalid OAuth URL");
});
it("rejects discovery issuer mismatch", async () => {
  const s = setup();
  await expect(
    Promise.resolve().then(() =>
      s.oauth.provider.saveDiscoveryState?.({
        authorizationServerUrl: "https://auth.example",
        authorizationServerMetadata: {
          issuer: "https://evil.example",
          authorization_endpoint: "https://evil.example/auth",
          token_endpoint: "https://evil.example/token",
          response_types_supported: ["code"],
        },
      }),
    ),
  ).rejects.toThrow("issuer mismatch");
});
it("sends configured headers only to the MCP origin", async () => {
  const s = setup();
  await s.seed();
  const seen: [string, string | null][] = [];
  let token = "";
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      seen.push([url, new Headers(init?.headers).get("x-api-key")]);
      if (url === "https://auth.example/token") {
        token = "access";
        return Promise.resolve(
          Response.json({
            access_token: token,
            refresh_token: "refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      }
      if (init?.method === "GET")
        return Promise.resolve(new Response(null, { status: 405 }));
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${token}`)
        return Promise.resolve(
          new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://meta.example/prm"',
            },
          }),
        );
      const request = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as { id?: number; method?: string };
      if (request.id === undefined)
        return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(
        Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "initialize"
              ? {
                  protocolVersion: "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "test", version: "1" },
                }
              : {
                  tools: [{ name: "lookup", inputSchema: { type: "object" } }],
                },
        }),
      );
    }),
  );
  const config = {
    name: "remote",
    url: s.options.serverUrl,
    readTools: ["lookup"],
    headers: { "x-api-key": "secret" },
  };
  const access = { identity, authorize: () => Promise.resolve(true) };
  await expect(
    connectMcp(config, access, AbortSignal.timeout(2000), s.oauth),
  ).rejects.toThrow();
  const state = [...s.records.values()][0]?.pending?.state;
  await s.oauth.complete(
    new URLSearchParams({
      state: String(state),
      code: "code",
      iss: "https://auth.example",
    }),
  );
  await (
    await connectMcp(config, access, AbortSignal.timeout(2000), s.oauth)
  ).close();
  const auth = seen.filter(([url]) => url.startsWith("https://meta.example"));
  const mcp = seen.filter(([url]) => url === "https://mcp.example/mcp");
  expect(auth.length).toBeGreaterThan(0);
  expect(auth.every(([, key]) => key === null)).toBe(true);
  expect(mcp.every(([, key]) => key === "secret")).toBe(true);
});
it("cancels a pending login without deleting tokens", async () => {
  const s = setup();
  await s.oauth.provider.saveTokens({
    access_token: "t",
    token_type: "Bearer",
  });
  await s.oauth.provider.state?.();
  await expect(s.oauth.provider.state?.()).rejects.toThrow("already pending");
  await s.oauth.cancelPending();
  await expect(s.oauth.provider.state?.()).resolves.toBeTruthy();
  expect((await s.oauth.provider.tokens())?.access_token).toBe("t");
});
it.each([
  [undefined, "none"],
  ["client_secret_basic", "client_secret_basic"],
  ["client_secret_post", "client_secret_post"],
] as const)("supports confidential clients (%s)", async (method, expected) => {
  const s = setup();
  const oauth = createMcpOAuth({
    ...s.options,
    clientId: "id",
    ...(method ? { clientSecret: "secret", clientAuthMethod: method } : {}),
    clientMetadataUrl: "https://app.example/client.json",
  });
  expect(oauth.provider.clientMetadata.token_endpoint_auth_method).toBe(
    method ? expected : "none",
  );
  expect(oauth.provider.clientMetadataUrl).toBe(
    "https://app.example/client.json",
  );
  expect(await oauth.provider.clientInformation()).toEqual({
    client_id: "id",
    ...(method ? { client_secret: "secret" } : {}),
  });
});
it("rejects invalid client options", () => {
  const { options } = setup();
  expect(() => createMcpOAuth({ ...options, clientSecret: "s" })).toThrow();
  expect(() =>
    createMcpOAuth({ ...options, clientMetadataUrl: "http://x.example/a" }),
  ).toThrow();
});
