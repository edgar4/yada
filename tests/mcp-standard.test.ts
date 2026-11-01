import { contentText } from "../src/core/content.js";
import { afterEach, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { drivers, storageFixture } from "./helpers/storage.js";
import { connectMcpTransport } from "../src/connectors/mcp/session.js";
import { mcpConfig } from "../src/connectors/mcp/config.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { operationId } from "../src/storage/actions.js";
import {
  reconnectingMcp,
  type McpConfig,
  type McpConnection,
  type Tool,
} from "../src/index.js";

const identity = { actorId: "a", tenantId: "t" };
const signal = () => AbortSignal.timeout(3000);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
  const server = new McpServer({ name: "std", version: "1" });
  const send = vi.fn((text: string) => ({
    content: [{ type: "text" as const, text }],
  }));
  server.registerTool("send", { inputSchema: { to: z.string() } }, ({ to }) =>
    send(`sent ${to}`),
  );
  server.registerTool("fail", {}, () => ({
    isError: true,
    content: [{ type: "text", text: "nope" }],
  }));
  server.registerTool("lookup", { annotations: { readOnlyHint: true } }, () =>
    send("found"),
  );
  server.registerTool("other", {}, () => send("other"));
  const note = server.registerResource(
    "note",
    "file:///note",
    { mimeType: "text/plain" },
    (uri) => ({ contents: [{ uri: uri.href, text: "x".repeat(40_000) }] }),
  );
  server.registerResource(
    "bin",
    "file:///bin",
    { mimeType: "image/png" },
    (uri) => ({
      contents: [{ uri: uri.href, blob: "AA==", mimeType: "image/png" }],
    }),
  );
  server.registerPrompt(
    "greet",
    { description: "Greeting", argsSchema: { who: z.string() } },
    ({ who }) => ({
      messages: [
        { role: "user", content: { type: "text", text: `Hello ${who}` } },
      ],
    }),
  );
  async function connect(config: Partial<McpConfig>, owner = identity) {
    const [client, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote);
    const connection = await connectMcpTransport(
      { name: "std", url: "https://x.test/mcp", ...config } as McpConfig,
      { identity: owner, authorize: () => Promise.resolve(true) },
      client,
      signal(),
    );
    cleanups.push(async () => {
      await connection.close();
      await server.close();
    });
    return connection;
  }
  return { server, send, note, connect };
}
const find = (
  connection: Awaited<ReturnType<ReturnType<typeof fixture>["connect"]>>,
  name: string,
) => {
  const tool = connection.tools.find((t) => t.spec.name === `std__${name}`);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
};

it("validates confirm configuration", () => {
  const base = { name: "a", url: "https://x.test/mcp" };
  expect(() => mcpConfig.parse({ ...base, confirmTools: "*" })).not.toThrow();
  expect(() => mcpConfig.parse({ ...base, confirmTools: [] })).toThrow();
  expect(() =>
    mcpConfig.parse({ ...base, confirmTools: ["x"], readTools: ["x"] }),
  ).toThrow();
  expect(() =>
    mcpConfig.parse({
      ...base,
      confirmTools: ["x"],
      writeTools: { x: { version: "1", prepareTool: "p", receiptTool: "r" } },
    }),
  ).toThrow();
  expect(() =>
    mcpConfig.parse({
      ...base,
      confirmTools: ["p"],
      writeTools: { x: { version: "1", prepareTool: "p", receiptTool: "r" } },
    }),
  ).toThrow();
});
it("exposes listed tools as confirm tools and keeps the rest hidden", async () => {
  const f = fixture();
  const connection = await f.connect({ confirmTools: ["send", "fail"] });
  expect(connection.tools.map((t) => [t.spec.name, t.effect]).sort()).toEqual([
    ["std__fail", "write"],
    ["std__lookup", "read"],
    ["std__send", "write"],
  ]);
  const tool = find(connection, "send");
  if (tool.effect !== "write") throw new Error("expected write");
  expect("reconcile" in tool).toBe(false);
  expect(await tool.prepare({ to: "bob" }, identity, signal())).toMatchObject({
    preview: 'std__send({"to":"bob"})',
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(
    await tool.execute(
      { to: "bob" },
      { identity, operationId: "o", version: "1", signal: signal() },
    ),
  ).toBe("sent bob");
  await expect(connection.close()).resolves.toBeUndefined();
});
it("star confirms every unassigned tool not annotated read-only", async () => {
  const f = fixture();
  const connection = await f.connect({ confirmTools: "*" });
  expect(connection.tools.map((t) => [t.spec.name, t.effect]).sort()).toEqual([
    ["std__fail", "write"],
    ["std__lookup", "read"],
    ["std__other", "write"],
    ["std__send", "write"],
  ]);
  const assigned = await fixture().connect({
    confirmTools: "*",
    readTools: ["other"],
  });
  expect(assigned.tools.map((t) => [t.spec.name, t.effect]).sort()).toEqual([
    ["std__fail", "write"],
    ["std__other", "read"],
    ["std__send", "write"],
  ]);
});
it("returns remote isError results to the model", async () => {
  const connection = await fixture().connect({ confirmTools: ["fail"] });
  const tool = find(connection, "fail");
  if (tool.effect !== "write") throw new Error("expected write");
  expect(
    JSON.parse(
      await tool.execute(
        {},
        { identity, operationId: "o", version: "1", signal: signal() },
      ),
    ),
  ).toEqual({ error: "tool_failed", message: "nope" });
});
it("rejects missing confirm tools", async () => {
  await expect(
    fixture().connect({ confirmTools: ["missing"] }),
  ).rejects.toThrow("Configured MCP tool not found");
});
it("bounds resource tools and renders text only", async () => {
  const connection = await fixture().connect({ resources: true });
  const list = find(connection, "list_resources");
  const read = find(connection, "read_resource");
  if (list.effect !== "read" || read.effect !== "read")
    throw new Error("expected reads");
  expect(
    (
      JSON.parse(contentText(await list.execute({}, identity, signal()))) as {
        resources: { uri: string }[];
      }
    ).resources.map((r) => r.uri),
  ).toEqual(["file:///note", "file:///bin"]);
  expect(
    (await read.execute({ uri: "file:///note" }, identity, signal())).length,
  ).toBe(32_000);
  expect(await read.execute({ uri: "file:///bin" }, identity, signal())).toBe(
    "[blob: image/png]",
  );
  await expect(
    read.execute({ uri: "file:///none" }, identity, signal()),
  ).rejects.toThrow("MCP request failed");
  expect(
    (await fixture().connect({})).tools.some((t) =>
      t.spec.name.endsWith("_resources"),
    ),
  ).toBe(false);
});
it("lists prompts and renders them as text", async () => {
  const connection = await fixture().connect({});
  expect(await connection.prompts?.()).toEqual([
    {
      name: "greet",
      description: "Greeting",
      arguments: [{ name: "who", required: true }],
    },
  ]);
  expect(await connection.getPrompt?.("greet", { who: "Ada" })).toBe(
    "Hello Ada",
  );
});
it("goes stale only when the authorized contract changes", async () => {
  const f = fixture();
  const connection = await f.connect({ confirmTools: ["send"] });
  const read = find(connection, "lookup");
  if (read.effect !== "read") throw new Error("expected read");
  const extra = f.server.registerTool("extra", {}, () => f.send("extra"));
  await vi.waitFor(async () => {
    await read.execute({}, identity, signal());
  });
  extra.remove();
  await read.execute({}, identity, signal());
  expect(connection.isConnected?.()).toBe(true);
  const other = f.server.registerTool(
    "later",
    { annotations: { readOnlyHint: true } },
    () => f.send("later"),
  );
  await expect(
    vi.waitFor(async () => {
      await read.execute({}, identity, signal());
      throw new Error("still fresh");
    }),
  ).rejects.toThrow("contract changed");
  expect(connection.isConnected?.()).toBe(false);
  other.remove();
  await expect(connection.getPrompt?.("greet", { who: "x" })).rejects.toThrow(
    "reconnect required",
  );
});
it("reconnects a stale confirm tool through the contract check", async () => {
  const first = fixture();
  const original = await first.connect({ confirmTools: ["send"] });
  const second = fixture();
  const replacement = await second.connect({ confirmTools: ["send"] });
  const connection = await reconnectingMcp(
    vi
      .fn<() => Promise<McpConnection<Tool>>>()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement),
  );
  cleanups.push(() => connection.close());
  const tool = connection.tools.find((t) => t.spec.name === "std__send");
  if (tool?.effect !== "write") throw new Error("expected write");
  first.server.registerTool(
    "later",
    { annotations: { readOnlyHint: true } },
    () => first.send("later"),
  );
  await vi.waitFor(() => {
    expect(original.isConnected?.()).toBe(false);
  });
  expect(
    await tool.execute(
      { to: "z" },
      { identity, operationId: "o", version: "1", signal: signal() },
    ),
  ).toBe("sent z");
  expect(first.send).not.toHaveBeenCalled();
  expect(second.send).toHaveBeenCalledOnce();
});
for (const driver of drivers)
  it(`runs a confirm MCP tool through the worker only after approval (${driver})`, async () => {
    const s = await storageFixture(driver);
    const f = fixture();
    const connection = await f.connect({ confirmTools: ["send"] }, s.identity);
    const call = { id: "call", name: "std__send", args: { to: "bob" } };
    const provider = createFakeProvider((_req, n) =>
      n === 1
        ? { content: "", toolCalls: [call], finishReason: "tool_calls" }
        : { content: "Done", toolCalls: [], finishReason: "stop" },
    );
    await s.storage.jobs.submit(s.identity, "chat", {
      id: "run",
      input: "Go",
      profileId: "v1",
    });
    const worker = createWorker({
      storage: s.storage,
      profiles: {
        v1: { provider, tools: [...connection.tools], system: "Help" },
      },
    });
    await worker.tick();
    expect((await s.storage.jobs.load(s.identity, "chat", "run"))?.status).toBe(
      "awaiting_approval",
    );
    await worker.tick();
    expect(f.send).not.toHaveBeenCalled();
    await s.storage.actions.decide(
      s.identity,
      operationId(s.identity, JSON.stringify(["chat", "run"]), call.id),
      true,
    );
    await s.storage.jobs.update(s.identity, "chat", "run", { type: "queued" });
    await worker.tick();
    expect((await s.storage.jobs.load(s.identity, "chat", "run"))?.status).toBe(
      "completed",
    );
    expect(f.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
      "sent bob",
    );
  });
