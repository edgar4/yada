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
