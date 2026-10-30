import { afterEach, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  protocolServer,
  mutation,
  owner,
  writeConfig,
} from "./helpers/mcp-protocol.js";
import { mcpWriteTools } from "./helpers/mcp-write-server.js";
import { mcpConfig } from "../src/connectors/mcp/config.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function setup(options: Parameters<typeof protocolServer>[0] = {}) {
  const server = protocolServer(options);
  cleanups.push(() => server.close());
  return server;
}
const signal = () => AbortSignal.timeout(3000);
const context = () => ({
  identity: owner,
  operationId: "operation-1",
  version: "state-1",
  signal: signal(),
});
function withoutOutputSchemas(): Tool[] {
  return structuredClone(mcpWriteTools).map((tool) => {
    delete tool.outputSchema;
    return tool;
  });
}

it("hides helpers and forwards only owned operation metadata outside model arguments", async () => {
  const s = setup();
  const connection = await s.connect();
  const tool = mutation(connection);
  expect(
    connection.tools.map((candidate) => [
      candidate.spec.name,
      candidate.effect,
    ]),
  ).toEqual([["remote__change", "write"]]);
  expect(await tool.prepare({ value: "Ada" }, owner, signal())).toEqual({
    preview: "Change",
    version: "state-1",
  });
  expect(await tool.execute({ value: "Ada" }, context())).toBe("receipt-1");
  expect(await tool.reconcile("operation-1", owner, signal())).toBeUndefined();
  expect(s.calls.mock.calls.map(([request]) => request)).toEqual([
    {
      name: "preview",
      arguments: { arguments: { value: "Ada" } },
      _meta: {
        "io.yada/action": {
          contractVersion: 1,
          tool: "change",
          actorId: owner.actorId,
          tenantId: owner.tenantId,
        },
      },
    },
    {
      name: "change",
      arguments: { value: "Ada" },
      _meta: {
        "io.yada/action": {
          contractVersion: 1,
          tool: "change",
          actorId: owner.actorId,
          tenantId: owner.tenantId,
          operationId: "operation-1",
          version: "state-1",
        },
      },
    },
    {
      name: "receipt",
      arguments: {},
      _meta: {
        "io.yada/action": {
          contractVersion: 1,
          tool: "change",
          actorId: owner.actorId,
          tenantId: owner.tenantId,
          operationId: "operation-1",
        },
      },
    },
  ]);
});
it("keeps mutations outside automatic read discovery", async () => {
  const s = setup();
  const connection = await s.connect({ name: "remote", url: writeConfig.url });
  expect(connection.tools.every((tool) => tool.effect === "read")).toBe(true);
  expect(
    connection.tools.some((tool) => tool.spec.name === "remote__change"),
  ).toBe(false);
});
it.each([
  { readTools: ["change"] },
  { readTools: ["preview"] },
  { readTools: ["x", "x"] },
  {
    writeTools: {
      change: { version: "1", prepareTool: "receipt", receiptTool: "receipt" },
    },
  },
  {
    writeTools: {
      change: { version: "1", prepareTool: "change", receiptTool: "receipt" },
    },
  },
  {
    writeTools: {
      ...writeConfig.writeTools,
      other: { version: "1", prepareTool: "preview", receiptTool: "receipt2" },
    },
  },
  { writeTools: { change: { ...writeConfig.writeTools.change, extra: true } } },
  { writeTools: {} },
])("rejects ambiguous or unsupported reviewed roles %j", (change) => {
  expect(() => mcpConfig.parse({ ...writeConfig, ...change })).toThrow();
});
it.each(["preview", "receipt"])(
  "requires a separate current grant for hidden helper %s",
  async (helper) => {
    const s = setup();
    const tool = mutation(await s.connect());
    s.authorize.mockImplementation((identity, name) =>
      Promise.resolve(identity.actorId === owner.actorId && name !== helper),
    );
    await expect(
      helper === "preview"
        ? tool.prepare({ value: "Ada" }, owner, signal())
        : tool.reconcile("operation-1", owner, signal()),
    ).rejects.toThrow("denied");
    expect(s.calls).not.toHaveBeenCalled();
  },
);
it.each(["missing", "write-as-read", "mutating-helper", "unknown-helper"])(
  "fails discovery for %s",
  async (kind) => {
    const tools = structuredClone(mcpWriteTools);
    if (kind === "missing") tools.pop();
    const change = tools.find((tool) => tool.name === "change");
    const helper = tools.find((tool) => tool.name === "preview");
    if (!change || !helper) throw new Error("Missing fixture tools");
    if (kind === "write-as-read") change.annotations = { readOnlyHint: true };
    if (kind === "mutating-helper")
      helper.annotations = { readOnlyHint: false };
    if (kind === "unknown-helper") delete helper.annotations;
    await expect(setup({ tools }).connect()).rejects.toThrow();
  },
);
it.each(["prepare", "execute", "reconcile"] as const)(
  "reauthorizes and scopes direct %s calls, including cancellation and close",
  async (phase) => {
    const s = setup();
    const connection = await s.connect();
    const tool = mutation(connection);
    const invoke = (identity = owner, abort = signal()) =>
      phase === "prepare"
        ? tool.prepare({ value: "Ada" }, identity, abort)
        : phase === "execute"
          ? tool.execute(
              { value: "Ada" },
              { ...context(), identity, signal: abort },
            )
          : tool.reconcile("operation-1", identity, abort);
    await expect(invoke({ ...owner, actorId: "other" })).rejects.toThrow(
      "denied",
    );
    await expect(invoke({ ...owner, tenantId: "other" })).rejects.toThrow(
      "denied",
    );
    await expect(invoke(owner, AbortSignal.abort())).rejects.toThrow();
    s.authorize.mockResolvedValue(false);
    await expect(invoke()).rejects.toThrow("denied");
    s.authorize.mockResolvedValue(true);
    await connection.close();
    await expect(invoke()).rejects.toThrow("denied");
    expect(s.calls).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  [],
  { value: 1 },
  { value: "Ada", _meta: { "io.yada/action": { operationId: "forged" } } },
  { value: "x".repeat(32000) },
])(
  "rejects invalid or oversized model arguments before preparation: %j",
  async (args) => {
    const s = setup();
    const tool = mutation(await s.connect());
    await expect(tool.prepare(args, owner, signal())).rejects.toThrow();
    expect(s.calls).not.toHaveBeenCalled();
  },
);
it.each([
  ["prepare", { preview: "", version: "1" }],
  ["prepare", { preview: "Change", version: "" }],
  ["prepare", { preview: "Change", version: "1", approved: true }],
  ["execute", { status: "unknown" }],
  ["execute", { status: "completed", receipt: "" }],
  ["execute", { status: "completed" }],
  ["reconcile", { status: "completed", receipt: "" }],
  ["reconcile", { status: "unknown", receipt: "invented" }],
  ["execute", { status: "completed", receipt: "é".repeat(16001) }],
] as const)(
  "rejects malformed or oversized %s results",
  async (phase, structuredContent) => {
    const s = setup({ tools: withoutOutputSchemas() });
    const tool = mutation(await s.connect());
    s.calls.mockResolvedValue({ content: [], structuredContent });
    await expect(
      phase === "prepare"
        ? tool.prepare({ value: "Ada" }, owner, signal())
        : phase === "execute"
          ? tool.execute({ value: "Ada" }, context())
          : tool.reconcile("operation-1", owner, signal()),
    ).rejects.toThrow();
  },
);
it.each([
  { content: [{ type: "text", text: "receipt" }] },
  {
    isError: true,
    content: [],
    structuredContent: { status: "completed", receipt: "invented" },
  },
] satisfies CallToolResult[])(
  "never treats text or tool errors as authoritative success",
  async (result) => {
    const s = setup({ tools: withoutOutputSchemas() });
    const tool = mutation(await s.connect());
    s.calls.mockResolvedValue(result);
    await expect(tool.execute({ value: "Ada" }, context())).rejects.toThrow();
  },
);
it("pins earlier-page output schemas and rejects asynchronous input validation", async () => {
  const s = setup({ pageSize: 1 });
  const tool = mutation(await s.connect());
  s.calls.mockResolvedValue({
    content: [],
    structuredContent: { preview: "Change", version: "1", extra: true },
  });
  await expect(tool.prepare({ value: "Ada" }, owner, signal())).rejects.toThrow(
    "Invalid MCP output",
  );
  const tools = withoutOutputSchemas();
  const change = tools.find((item) => item.name === "change");
  if (!change) throw new Error("Missing fixture tool");
  change.inputSchema["$async"] = true;
  await expect(setup({ tools }).connect()).rejects.toThrow(
    "asynchronous MCP schema",
  );
});
it("validates helper schemas and trusted operation identifiers before any remote call", async () => {
  const s = setup();
  const tool = mutation(await s.connect());
  await expect(
    tool.execute({ value: "Ada" }, { ...context(), operationId: "" }),
  ).rejects.toThrow();
  await expect(
    tool.execute({ value: "Ada" }, { ...context(), version: "" }),
  ).rejects.toThrow();
  await expect(tool.reconcile("", owner, signal())).rejects.toThrow();
  expect(s.calls).not.toHaveBeenCalled();
  const tools = withoutOutputSchemas();
  const prepare = tools.find((item) => item.name === "preview");
  if (!prepare) throw new Error("Missing fixture helper");
  prepare.inputSchema = {
    type: "object",
    properties: { required: { type: "string" } },
    required: ["required"],
    additionalProperties: false,
  };
  const other = setup({ tools });
  const invalid = mutation(await other.connect());
  await expect(
    invalid.prepare({ value: "Ada" }, owner, signal()),
  ).rejects.toThrow("Invalid MCP arguments");
  expect(other.calls).not.toHaveBeenCalled();
});
