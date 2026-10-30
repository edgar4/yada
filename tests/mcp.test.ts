import { afterEach, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { connectMcpTransport } from "../src/connectors/mcp/session.js";
import { connectMcp, createFakeProvider, run } from "../src/index.js";
const owner = { actorId: "a", tenantId: "t" };
const tool: Tool = {
  name: "lookup",
  description: "Lookup",
  inputSchema: {
    type: "object" as const,
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.unstubAllGlobals();
});
async function setup(
  options: {
    tools?: Tool[];
    result?: CallToolResult;
    pages?: boolean;
    repeat?: boolean;
  } = {},
) {
  const server = new McpServer(
    { name: "test", version: "1" },
    { capabilities: { tools: {} } },
  );
  const calls = vi.fn(
    () =>
      options.result ?? {
        content: [{ type: "text" as const, text: "Available" }],
      },
  );
  server.server.setRequestHandler(CallToolRequestSchema, calls);
  server.server.setRequestHandler(ListToolsRequestSchema, (request) =>
    options.repeat
      ? { tools: [], nextCursor: "same" }
      : options.pages && !request.params?.cursor
        ? { tools: [], nextCursor: "next" }
        : { tools: options.tools ?? [tool] },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  cleanups.push(() => server.close());
  const authorize = vi.fn(() => Promise.resolve(true));
  const connect = () =>
    connectMcpTransport(
      {
        name: "catalog",
        url: "https://example.test/mcp",
        readTools: ["lookup"],
      },
      { identity: owner, authorize },
      clientTransport,
      AbortSignal.timeout(3000),
    );
  return { connect, calls, authorize };
}
it("discovers paginated tools and completes a runtime round trip", async () => {
  const s = await setup({ pages: true });
  const connection = await s.connect();
  cleanups.push(connection.close);
  const provider = createFakeProvider((_request, call) =>
    call === 1
      ? {
          content: "",
          toolCalls: [{ id: "1", name: "catalog__lookup", args: { id: "a" } }],
          finishReason: "tool_calls",
        }
      : { content: "Available", toolCalls: [], finishReason: "stop" },
  );
  expect(
    await run({
      provider,
      tools: connection.tools,
      identity: owner,
      input: "Find a",
      system: "Help",
      signal: AbortSignal.timeout(3000),
    }),
  ).toEqual({ status: "completed", text: "Available" });
  expect(s.calls).toHaveBeenCalledOnce();
  expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
    content: "Available",
  });
});
it.each([{ id: 1 }, { id: "a", tenantId: "other" }, null])(
  "rejects invalid tool input %j",
  async (args) => {
    const s = await setup();
    const c = await s.connect();
    cleanups.push(c.close);
    await expect(
      c.tools[0]?.execute(args, owner, AbortSignal.timeout(1000)),
    ).rejects.toThrow();
    expect(s.calls).not.toHaveBeenCalled();
  },
);
it("rejects cross-tenant calls and revoked grants", async () => {
  const s = await setup();
  const c = await s.connect();
  cleanups.push(c.close);
  const t = c.tools[0];
  expect(await t?.authorize({ ...owner, tenantId: "other" })).toBe(false);
  await expect(
    t?.execute(
      { id: "a" },
      { ...owner, actorId: "other" },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow("access denied");
  s.authorize.mockResolvedValue(false);
  await expect(
    t?.execute({ id: "a" }, owner, AbortSignal.timeout(1000)),
  ).rejects.toThrow("access denied");
  expect(s.calls).not.toHaveBeenCalled();
});
it("invalidates tools on close", async () => {
  const s = await setup();
  const c = await s.connect();
  await c.close();
  expect(await c.tools[0]?.authorize(owner)).toBe(false);
});
it.each([
  { tools: [{ ...tool, annotations: { readOnlyHint: false } }] },
  { tools: [] },
  { tools: [tool, tool] },
  { repeat: true },
  {
    tools: [
      {
        ...tool,
        inputSchema: {
          type: "object" as const,
          properties: { id: { $ref: "https://invalid/schema" } },
        },
      },
    ],
  },
])("fails closed during invalid discovery %j", async (options) => {
  const s = await setup(options);
  await expect(s.connect()).rejects.toThrow();
});
it("excludes tools not explicitly allowed", async () => {
  const s = await setup({ tools: [tool, { ...tool, name: "delete" }] });
  const c = await s.connect();
  cleanups.push(c.close);
  expect(c.tools.map((t) => t.spec.name)).toEqual(["catalog__lookup"]);
});
it.each([
  {
    isError: true,
    content: [{ type: "text" as const, text: "private error" }],
  },
  { content: [{ type: "image" as const, data: "a", mimeType: "image/png" }] },
  { content: [{ type: "text" as const, text: "x".repeat(32001) }] },
])(
  "rejects tool error, unsupported content, or oversized results",
  async (result) => {
    const s = await setup({ result });
    const c = await s.connect();
    cleanups.push(c.close);
    await expect(
      c.tools[0]?.execute({ id: "a" }, owner, AbortSignal.timeout(1000)),
    ).rejects.toThrow();
  },
);
it("preserves structured results", async () => {
  const s = await setup({
    result: { content: [], structuredContent: { available: true } },
  });
  const c = await s.connect();
  cleanups.push(c.close);
  expect(
    await c.tools[0]?.execute({ id: "a" }, owner, AbortSignal.timeout(1000)),
  ).toBe('{"available":true}');
});
it("propagates cancellation before execution", async () => {
  const s = await setup();
  const c = await s.connect();
  cleanups.push(c.close);
  await expect(
    c.tools[0]?.execute({ id: "a" }, owner, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(s.calls).not.toHaveBeenCalled();
});
it("sends bearer authentication and refuses HTTP redirects", async () => {
  const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer secret",
    );
    expect(init?.redirect).toBe("error");
    return Promise.resolve(new Response("", { status: 403 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    connectMcp(
      {
        name: "remote",
        url: "https://example.test/mcp",
        token: "secret",
        readTools: ["lookup"],
      },
      { identity: owner, authorize: () => Promise.resolve(true) },
    ),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalled();
});
it("connects to a real stdio child and closes it", async () => {
  const connection = await connectMcp(
    {
      name: "local",
      command: process.execPath,
      args: ["--import", "tsx", "tests/fixtures/mcp-server.ts"],
      readTools: ["lookup"],
    },
    { identity: owner, authorize: () => Promise.resolve(true) },
    AbortSignal.timeout(5000),
  );
  cleanups.push(connection.close);
  expect(
    await connection.tools[0]?.execute(
      { id: "a" },
      owner,
      AbortSignal.timeout(3000),
    ),
  ).toBe("Found a");
});
it("accepts JSON Schema 2020-12 input", async () => {
  const s = await setup({
    tools: [
      {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          $schema: "https://json-schema.org/draft/2020-12/schema",
        },
      },
    ],
  });
  const c = await s.connect();
  cleanups.push(c.close);
  expect(
    await c.tools[0]?.execute({ id: "a" }, owner, AbortSignal.timeout(1000)),
  ).toBe("Available");
});
it("rejects invalid names before exposing tools", async () => {
  const s = await setup({ tools: [{ ...tool, name: "lookup space" }] });
  await expect(s.connect()).rejects.toThrow();
});
