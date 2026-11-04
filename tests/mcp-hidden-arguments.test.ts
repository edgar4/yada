import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { connectMcpTransport } from "../src/connectors/mcp/session.js";
import { mcpConfig } from "../src/connectors/mcp/config.js";
import type { McpConfig, Tool } from "../src/index.js";

const identity = { actorId: "a", tenantId: "t" };
const signal = () => AbortSignal.timeout(3000);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

async function connect(config: Partial<McpConfig>) {
  const server = new McpServer({ name: "s", version: "1" });
  const seen = vi.fn();
  const input = { item: z.string(), key: z.uuid() };
  const text = { content: [{ type: "text" as const, text: "ok" }] };
  server.registerTool("place", { inputSchema: input }, (args) => {
    seen(args);
    return {
      ...text,
      structuredContent: { status: "completed", receipt: "done" },
    };
  });
  server.registerTool(
    "prepare",
    {
      inputSchema: { arguments: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true },
    },
    (args) => {
      seen(args);
      return {
        ...text,
        structuredContent: { preview: "p", version: "1" },
      };
    },
  );
  server.registerTool(
    "receipt",
    { annotations: { readOnlyHint: true } },
    () => ({
      ...text,
      structuredContent: { status: "unknown" },
    }),
  );
  const [client, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  const connection = await connectMcpTransport(
    { name: "s", url: "https://x.test/mcp", ...config } as McpConfig,
    { identity, authorize: () => Promise.resolve(true) },
    client,
    signal(),
  );
  cleanups.push(async () => {
    await connection.close();
    await server.close();
  });
  const tool = connection.tools.find(
    (item) => item.spec.name === "s__place",
  ) as Extract<Tool, { effect: "write" }>;
  return { tool, seen };
}
const context = (operationId: string) => ({
  identity,
  signal: signal(),
  operationId,
  version: "1",
});
const parameters = (tool: Tool) =>
  tool.spec.parameters as { properties: object; required: string[] };

describe.each([
  ["confirmed", { confirmTools: ["place"], readTools: ["prepare"] }],
  [
    "write",
    {
      writeTools: {
        place: { version: "1", prepareTool: "prepare", receiptTool: "receipt" },
      },
    },
  ],
])("hidden arguments on %s tools", (_kind, roles) => {
  const hiddenArguments = { place: ["key"] };
  it("hides them from the model and derives stable values", async () => {
    const { tool, seen } = await connect({ ...roles, hiddenArguments });
    expect(parameters(tool).properties).not.toHaveProperty("key");
    expect(parameters(tool).required).toEqual(["item"]);
    await tool.execute({ item: "a", key: "from-model" }, context("one"));
    await tool.execute({ item: "a" }, context("one"));
    await tool.execute({ item: "a" }, context("two"));
    const keys = seen.mock.calls.map(([args]) => (args as { key: string }).key);
    expect(keys[0]).toMatch(uuid);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe("hidden argument configuration", () => {
  const writeTools = {
    place: { version: "1", prepareTool: "prepare", receiptTool: "receipt" },
  };
  it("prepares without sending hidden arguments", async () => {
    const { tool, seen } = await connect({
      writeTools,
      hiddenArguments: { place: ["key"] },
    });
    await tool.prepare({ item: "a", key: "x" }, identity, signal());
    expect(seen).toHaveBeenCalledWith({ arguments: { item: "a" } });
  });
  it("changes the approved version", async () => {
    const plain = await connect({ writeTools });
    const hidden = await connect({
      writeTools,
      hiddenArguments: { place: ["key"] },
    });
    expect(hidden.tool.version).not.toBe(plain.tool.version);
  });
  it("rejects read tools and unknown arguments", async () => {
    await expect(
      connect({ readTools: ["place"], hiddenArguments: { place: ["key"] } }),
    ).rejects.toThrow("need a write tool");
    await expect(
      connect({ writeTools, hiddenArguments: { place: ["nope"] } }),
    ).rejects.toThrow("Unknown MCP hidden argument");
    expect(() =>
      mcpConfig.parse({
        name: "s",
        command: "x",
        hiddenArguments: { place: [] },
      }),
    ).toThrow();
  });
});
