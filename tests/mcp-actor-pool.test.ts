import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpActorPool } from "../src/entries/mcp.js";
import {
  ToolCallError,
  createFakeProvider,
  run,
  type Tool,
} from "../src/index.js";
import type { McpOAuthStore, OAuthSession } from "../src/index.js";

const alice = { tenantId: "t", actorId: "alice" };
const bob = { tenantId: "t", actorId: "bob" };
const server = "https://mcp.example/mcp";
const signal = () => AbortSignal.timeout(3000);
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const item of close.splice(0)) await item();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function memoryStore() {
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
      const { pending } = record;
      delete record.pending;
      return Promise.resolve(pending);
    },
    remove: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
  };
  return { records, store };
}

function fakeServer() {
  const calls: { tool: string; bearer: string | null }[] = [];
  const sessions: string[] = [];
  const valid = new Set<string>();
  const json = (id: unknown, result: unknown) =>
    Response.json({ jsonrpc: "2.0", id, result });
  const metadata = {
    issuer: "https://auth.example",
    authorization_endpoint: "https://auth.example/authorize",
    token_endpoint: "https://auth.example/token",
    registration_endpoint: "https://auth.example/register",
    revocation_endpoint: "https://auth.example/revoke",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.includes("oauth-protected-resource"))
      return Promise.resolve(
        Response.json({
          resource: server,
          authorization_servers: ["https://auth.example"],
        }),
      );
    if (url.pathname.includes("oauth-authorization-server"))
      return Promise.resolve(Response.json(metadata));
    if (url.pathname === "/register")
      return Promise.resolve(
        Response.json(
          { client_id: "registered", redirect_uris: [] },
          { status: 201 },
        ),
      );
    if (url.pathname === "/revoke") return Promise.resolve(new Response(null));
    if (url.pathname === "/token") {
      const code = new URLSearchParams(init?.body as string).get("code") ?? "x";
      const token = `token-${code}`;
      valid.add(token);
      return Promise.resolve(
        Response.json({ access_token: token, token_type: "Bearer" }),
      );
    }
    if (init?.method === "GET" || init?.method === "DELETE")
      return Promise.resolve(new Response(null, { status: 405 }));
    const bearer =
      new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ??
      null;
    if (bearer && !valid.has(bearer))
      return Promise.resolve(new Response(null, { status: 401 }));
    const request = JSON.parse(init?.body as string) as {
      id?: number;
      method: string;
      params?: { name: string };
    };
    if (request.id === undefined)
      return Promise.resolve(new Response(null, { status: 202 }));
    if (request.method === "initialize") {
      sessions.push(bearer ?? "anonymous");
      return Promise.resolve(
        json(request.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "s", version: "1" },
        }),
      );
    }
    if (request.method === "tools/list")
      return Promise.resolve(
        json(request.id, {
          tools: [
            { name: "open", inputSchema: { type: "object" } },
            { name: "mine", inputSchema: { type: "object" } },
            { name: "change", inputSchema: { type: "object" } },
          ],
        }),
      );
    const tool = request.params?.name ?? "";
    calls.push({ tool, bearer });
    return Promise.resolve(
      json(request.id, {
        content: [{ type: "text", text: `${tool}:${bearer ?? "anonymous"}` }],
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, sessions, valid, fetchMock };
}

async function setup(
  overrides: { idleMs?: number; maxConnections?: number } = {},
) {
  const backend = fakeServer();
  const memory = memoryStore();
  const authorize = vi.fn(() => Promise.resolve(true));
  const pool = await createMcpActorPool({
    config: {
      name: "s",
      url: server,
      readTools: ["open", "mine"],
      confirmTools: ["change"],
    },
    redirectUrl: "https://app.example/callback",
    store: memory.store,
    authorize,
    publicTools: ["open"],
    signal: signal(),
    ...overrides,
  });
  close.push(() => pool.close());
  const read = (name: string) => {
    const tool = pool.tools.find((item) => item.spec.name === `s__${name}`);
    if (tool?.effect !== "read") throw new Error("read expected");
    return tool;
  };
  const change = pool.tools.find(
    (item) => item.spec.name === "s__change",
  ) as Extract<Tool, { effect: "write" }>;
  const connect = async (identity: typeof alice) => {
    const url = await pool.beginConnect(identity, signal());
    const state = url?.searchParams.get("state");
    return pool.completeConnect(
      new URLSearchParams({
        state: String(state),
        code: identity.actorId,
        iss: "https://auth.example",
      }),
      signal(),
    );
  };
  return { ...backend, ...memory, pool, read, change, connect, authorize };
}

describe("createMcpActorPool", () => {
  it("runs public tools anonymously for an actor with no connection", async () => {
    const s = await setup();
    expect(await s.read("open").execute({}, alice, signal())).toBe(
      "open:anonymous",
    );
    expect(s.authorize).toHaveBeenCalledWith(alice, "open");
  });

  it("denies a public tool the app does not authorize", async () => {
    const s = await setup();
    s.authorize.mockResolvedValue(false);
    await expect(s.read("open").execute({}, alice, signal())).rejects.toThrow(
      "MCP access denied",
    );
  });

  it("reports not connected without writing, for reads and writes", async () => {
    const s = await setup();
    const before = s.records.size;
    const error: unknown = await s
      .read("mine")
      .execute({}, alice, signal())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolCallError);
    expect(error).toMatchObject({
      code: "not_connected",
      delivery: "not_sent",
    });
    await expect(s.change.prepare({}, alice, signal())).rejects.toMatchObject({
      code: "not_connected",
    });
    await expect(
      s.change.execute(
        {},
        {
          identity: alice,
          signal: signal(),
          operationId: "op",
          version: "1",
        },
      ),
    ).rejects.toMatchObject({ code: "not_connected" });
    expect(s.records.size).toBe(before);
    expect(await s.pool.isConnected(alice)).toBe(false);
  });

  it("gives the model a clear result when not connected", async () => {
    const s = await setup();
    const provider = createFakeProvider((_request, call) =>
      call === 1
        ? {
            content: "",
            toolCalls: [{ id: "1", name: "s__mine", args: {} }],
            finishReason: "tool_calls",
          }
        : { content: "Done", toolCalls: [], finishReason: "stop" },
    );
    await run({
      provider,
      tools: [s.read("mine")],
      identity: alice,
      input: "Hi",
      system: "Help",
      signal: signal(),
    });
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain(
      "account_not_connected",
    );
  });

  it("recovers the actor from the state and keeps connections separate", async () => {
    const s = await setup();
    expect(await s.connect(alice)).toEqual(alice);
    expect(await s.connect(bob)).toEqual(bob);
    expect(await s.pool.isConnected(alice)).toBe(true);
    expect(await s.read("mine").execute({}, alice, signal())).toBe(
      "mine:token-alice",
    );
    expect(await s.read("mine").execute({}, bob, signal())).toBe(
      "mine:token-bob",
    );
    await s.read("mine").execute({}, alice, signal());
    expect(s.sessions.filter((item) => item === "token-alice")).toHaveLength(1);
  });

  it("runs an approved write on the actor's connection", async () => {
    const s = await setup();
    await s.connect(alice);
    expect(
      await s.change.execute(
        {},
        {
          identity: alice,
          signal: signal(),
          operationId: "op",
          version: "1",
        },
      ),
    ).toBe("change:token-alice");
  });

  it("rejects unknown and reused state without writing", async () => {
    const s = await setup();
    const before = s.records.size;
    await expect(
      s.pool.completeConnect(new URLSearchParams({ state: "guess" }), signal()),
    ).rejects.toThrow("Invalid or expired OAuth state");
    await expect(
      s.pool.completeConnect(new URLSearchParams(), signal()),
    ).rejects.toThrow("Invalid or expired OAuth state");
    expect(s.records.size).toBe(before);
    const url = await s.pool.beginConnect(alice, signal());
    const params = new URLSearchParams({
      state: String(url?.searchParams.get("state")),
      code: "alice",
      iss: "https://auth.example",
    });
    await s.pool.completeConnect(params, signal());
    await expect(s.pool.completeConnect(params, signal())).rejects.toThrow(
      "Invalid or expired OAuth state",
    );
  });

  it("reports not connected when the server rejects the tokens", async () => {
    const s = await setup();
    await s.connect(alice);
    await s.read("mine").execute({}, alice, signal());
    s.valid.clear();
    await expect(
      s.read("mine").execute({}, alice, signal()),
    ).rejects.toMatchObject({ code: "not_connected" });
    expect(await s.pool.isConnected(alice)).toBe(false);
  });

  it("reports not connected on connect failure with a login pending, and starts none", async () => {
    const s = await setup();
    await s.connect(alice);
    s.valid.clear();
    await expect(
      s.read("mine").execute({}, alice, signal()),
    ).rejects.toMatchObject({ code: "not_connected" });
    const record = [...s.records.values()].find((item) => item.client);
    expect(record?.pending).toBeUndefined();

    await s.connect(bob);
    const url = await s.pool.beginConnect(bob, signal());
    s.valid.clear();
    expect(url).toBeDefined();
    await expect(
      s.read("mine").execute({}, bob, signal()),
    ).rejects.toMatchObject({ code: "not_connected" });
  });

  it("serves concurrent actors when the pool is at its limit", async () => {
    const s = await setup({ maxConnections: 1 });
    await s.connect(alice);
    await s.connect(bob);
    expect(
      await Promise.all([
        s.read("mine").execute({}, alice, signal()),
        s.read("mine").execute({}, bob, signal()),
      ]),
    ).toEqual(["mine:token-alice", "mine:token-bob"]);
  });

  it("requires the browser binding when one was given", async () => {
    const s = await setup();
    const url = await s.pool.beginConnect(alice, signal(), "cookie");
    const params = new URLSearchParams({
      state: String(url?.searchParams.get("state")),
      code: "alice",
      iss: "https://auth.example",
    });
    await expect(s.pool.completeConnect(params, signal())).rejects.toThrow(
      "does not match the browser",
    );
    await expect(
      s.pool.completeConnect(params, signal(), "other"),
    ).rejects.toThrow("does not match the browser");
    expect(await s.pool.completeConnect(params, signal(), "cookie")).toEqual(
      alice,
    );
  });

  it("evicts idle connections and reconnects on next use", async () => {
    const s = await setup({ idleMs: 20 });
    await s.connect(alice);
    await s.read("mine").execute({}, alice, signal());
    await vi.waitFor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await s.read("mine").execute({}, alice, signal());
      expect(
        s.sessions.filter((item) => item === "token-alice").length,
      ).toBeGreaterThan(1);
    });
  });

  it("evicts the oldest idle connection past maxConnections", async () => {
    const s = await setup({ maxConnections: 1 });
    await s.connect(alice);
    await s.connect(bob);
    await s.read("mine").execute({}, alice, signal());
    await s.read("mine").execute({}, bob, signal());
    await s.read("mine").execute({}, alice, signal());
    expect(s.sessions.filter((item) => item === "token-alice")).toHaveLength(2);
  });

  it("disconnects an actor and revokes", async () => {
    const s = await setup();
    await s.connect(alice);
    await s.read("mine").execute({}, alice, signal());
    await s.pool.disconnect(alice, signal());
    expect(await s.pool.isConnected(alice)).toBe(false);
    await expect(
      s.read("mine").execute({}, alice, signal()),
    ).rejects.toMatchObject({ code: "not_connected" });
    expect(
      s.fetchMock.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
    ).toBe(true);
  });

  it("drops service headers and adds actorHeaders on actor connections", async () => {
    const backend = fakeServer();
    const memory = memoryStore();
    const pool = await createMcpActorPool({
      config: {
        name: "s",
        url: server,
        readTools: ["mine"],
        headers: { "x-api-key": "service" },
      },
      actorHeaders: { "x-client": "app" },
      redirectUrl: "https://app.example/callback",
      store: memory.store,
      authorize: () => Promise.resolve(true),
    });
    close.push(() => pool.close());
    const url = await pool.beginConnect(alice, signal());
    await pool.completeConnect(
      new URLSearchParams({
        state: String(url?.searchParams.get("state")),
        code: "alice",
        iss: "https://auth.example",
      }),
      signal(),
    );
    const mine = pool.tools[0];
    if (mine?.effect !== "read") throw new Error("read expected");
    await mine.execute({}, alice, signal());
    const headers = backend.fetchMock.mock.calls
      .map(([, init]) => new Headers(init?.headers))
      .filter((item) => item.get("authorization") === "Bearer token-alice");
    expect(headers.length).toBeGreaterThan(0);
    for (const item of headers) {
      expect(item.get("x-api-key")).toBeNull();
      expect(item.get("x-client")).toBe("app");
    }
  });

  it("drops service credentials from actor connections", async () => {
    const backend = fakeServer();
    backend.valid.add("service");
    const memory = memoryStore();
    const pool = await createMcpActorPool({
      config: {
        name: "s",
        url: server,
        readTools: ["open", "mine"],
        confirmTools: ["change"],
        token: "service",
      },
      redirectUrl: "https://app.example/callback",
      store: memory.store,
      authorize: () => Promise.resolve(true),
      publicTools: ["open"],
    });
    close.push(() => pool.close());
    const open = pool.tools.find((item) => item.spec.name === "s__open");
    if (open?.effect !== "read") throw new Error("read expected");
    expect(await open.execute({}, alice, signal())).toBe("open:service");
    const url = await pool.beginConnect(alice, signal());
    await pool.completeConnect(
      new URLSearchParams({
        state: String(url?.searchParams.get("state")),
        code: "alice",
        iss: "https://auth.example",
      }),
      signal(),
    );
    const mine = pool.tools.find((item) => item.spec.name === "s__mine");
    if (mine?.effect !== "read") throw new Error("read expected");
    expect(await mine.execute({}, alice, signal())).toBe("mine:token-alice");
  });
});
