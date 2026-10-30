import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createStorage, createMcpOAuth, connectMcp } from "../src/index.js";
import { coordinateOAuthTransport } from "../src/connectors/mcp/oauth-transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const identity = { actorId: "a", tenantId: "t" };
it("serializes SDK initialization, tool refresh and unsolicited SSE refresh across durable connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yada-sdk-oauth-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = {
    driver: "sqlite" as const,
    filename: join(directory, "oauth.sqlite"),
    encryptionKey: "ab".repeat(32),
  };
  const first = await createStorage(config);
  const second = await createStorage(config);
  cleanup.push(first.close, second.close);
  const options = {
    identity,
    serverUrl: "https://mcp.example/mcp",
    redirectUrl: "https://app.example/callback",
    redirect: () => Promise.resolve(),
  };
  const oauth = createMcpOAuth({ ...options, store: first.oauth });
  const other = createMcpOAuth({ ...options, store: second.oauth });
  await oauth.provider.saveClientInformation?.({
    client_id: "client",
    issuer: "https://auth.example",
  });
  await oauth.provider.saveDiscoveryState?.({
    authorizationServerUrl: "https://auth.example",
    authorizationServerMetadata: {
      issuer: "https://auth.example",
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token",
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"],
    },
  });
  await oauth.provider.saveTokens({
    access_token: "old",
    refresh_token: "refresh-0",
    token_type: "Bearer",
    issuer: "https://auth.example",
  });
  let accepted = "expired";
  let grants = 0;
  let active = 0;
  let peak = 0;
  let sse = false;
  const pendingRefresh: { waiting?: Promise<void> } = {};
  let refreshStarted = () => {};
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      if (String(input) === "https://auth.example/token") {
        active++;
        peak = Math.max(peak, active);
        refreshStarted();
        if (pendingRefresh.waiting) await pendingRefresh.waiting;
        await delay(20);
        const parameters = new URLSearchParams(init?.body as URLSearchParams);
        expect(parameters.get("refresh_token")).toBe(
          `refresh-${String(grants)}`,
        );
        grants++;
        active--;
        accepted = `access-${String(grants)}`;
        return Response.json({
          access_token: accepted,
          refresh_token: `refresh-${String(grants)}`,
          token_type: "Bearer",
        });
      }
      if (
        new Headers(init?.headers).get("authorization") !== `Bearer ${accepted}`
      )
        return new Response(null, { status: 401 });
      if (init?.method === "GET")
        return sse
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  streams.push(controller);
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            )
          : new Response(null, { status: 405 });
      const request = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as { id?: number; method?: string };
      if (request.id === undefined) return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "test", version: "1" },
              }
            : request.method === "tools/call"
              ? { content: [{ type: "text", text: "ok" }] }
              : {
                  tools: [{ name: "lookup", inputSchema: { type: "object" } }],
                },
      });
    }),
  );
  const settings = {
    name: "remote",
    url: options.serverUrl,
    readTools: ["lookup"],
  };
  const access = { identity, authorize: () => Promise.resolve(true) };
  const connections = await Promise.all([
    connectMcp(settings, access, AbortSignal.timeout(5000), oauth),
    connectMcp(settings, access, AbortSignal.timeout(5000), other),
  ]);
  for (const connection of connections) cleanup.push(connection.close);
  expect(grants).toBe(1);
  accepted = "expired";
  expect(
    await Promise.all(
      connections.map((connection) => {
        const tool = connection.tools[0];
        if (!tool) throw new Error("Missing tool");
        return tool.execute({}, identity, AbortSignal.timeout(5000));
      }),
    ),
  ).toEqual(["ok", "ok"]);
  expect(grants).toBe(2);
  for (const connection of connections) await connection.close();
  sse = true;
  const streaming = await Promise.all([
    connectMcp(settings, access, AbortSignal.timeout(5000), oauth),
    connectMcp(settings, access, AbortSignal.timeout(5000), other),
  ]);
  for (const connection of streaming) cleanup.push(connection.close);
  await vi.waitFor(() => {
    expect(streams).toHaveLength(2);
  });
  accepted = "expired";
  for (const stream of streams.slice()) {
    stream.enqueue(new TextEncoder().encode("retry: 5\nid: last\n\n"));
    stream.close();
  }
  await vi.waitFor(
    () => {
      expect(streams).toHaveLength(4);
    },
    { timeout: 5000 },
  );
  expect(grants).toBe(3);
  expect(peak).toBe(1);
  expect((await other.provider.tokens())?.access_token).toBe("access-3");
  let finish = () => {};
  pendingRefresh.waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  accepted = "expired";
  const stale = streaming[0].tools[0]?.execute(
    {},
    identity,
    AbortSignal.timeout(5000),
  );
  await started;
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60000);
  await other.disconnect();
  finish();
  await expect(stale).rejects.toThrow("MCP OAuth request failed");
  clock.mockRestore();
  expect(await oauth.provider.tokens()).toBeUndefined();
});

it("fails closed when the pinned SDK background authentication hook is unavailable", () => {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://mcp.example"),
  );
  Object.defineProperty(transport, "_startOrAuthSse", { value: undefined });
  const oauth = {
    provider: {} as ReturnType<typeof createMcpOAuth>["provider"],
    serverUrl: "https://mcp.example/",
    identity,
    complete: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    coordinate: <T>(operation: () => Promise<T>) => operation(),
  };
  expect(() => {
    coordinateOAuthTransport(transport, oauth);
  }).toThrow("Unsupported MCP OAuth transport");
});

it("preserves a pending login and fences provider callbacks inherited from a completed lifecycle", async () => {
  const sessions = new Map<string, import("../src/index.js").OAuthSession>();
  const store = {
    load: (key: string) => Promise.resolve(sessions.get(key)),
    update: (key: string, patch: import("../src/index.js").OAuthSession) => {
      sessions.set(key, { ...sessions.get(key), ...patch });
      return Promise.resolve();
    },
    consumePending: () => Promise.resolve(undefined),
  };
  const options = {
    serverUrl: "https://mcp.example",
    redirectUrl: "https://app.example/callback",
    identity,
    store,
    redirect: () => Promise.resolve(),
  };
  const oauth = createMcpOAuth(options);
  const second = createMcpOAuth(options);
  const state = await oauth.provider.state?.();
  await expect(second.provider.state?.()).rejects.toThrow("already pending");
  expect([...sessions.values()][0]?.pending?.state).toBe(state);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 700_000);
  await expect(oauth.provider.saveCodeVerifier("late")).rejects.toThrow(
    "flow not started",
  );
  expect(await second.provider.state?.()).not.toBe(state);
  clock.mockRestore();
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let delayed: Promise<void> | undefined;
  await oauth.coordinate?.(() => {
    delayed = waiting.then(() =>
      oauth.provider.saveTokens({
        access_token: "stale",
        token_type: "Bearer",
      }),
    );
    return Promise.resolve();
  });
  await second.provider.saveTokens({
    access_token: "fresh",
    token_type: "Bearer",
  });
  finish();
  await expect(delayed).rejects.toThrow("coordination lost");
  expect((await oauth.provider.tokens())?.access_token).toBe("fresh");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const owner = oauth.coordinate?.(() => {
    started();
    return held;
  });
  await ready;
  await expect(
    second.coordinate?.(() => Promise.resolve(), AbortSignal.timeout(20)),
  ).rejects.toThrow();
  const third = vi.fn(() => Promise.resolve());
  const queued = second.coordinate?.(third);
  await delay(30);
  expect(third).not.toHaveBeenCalled();
  release();
  await owner;
  await queued;
  expect(third).toHaveBeenCalledOnce();
});

it("redacts SDK transport errors", async () => {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://mcp.example"),
  );
  transport.send = () => Promise.reject(new Error("private-token-response"));
  const oauth = {
    provider: {} as ReturnType<typeof createMcpOAuth>["provider"],
    serverUrl: "https://mcp.example/",
    identity,
    complete: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    coordinate: <T>(operation: () => Promise<T>) => operation(),
  };
  coordinateOAuthTransport(transport, oauth);
  await expect(
    transport.send({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  ).rejects.toThrow("MCP OAuth request failed");
});
