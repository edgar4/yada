import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Identity } from "../../src/core/contracts.js";

const input = {
  type: "object" as const,
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
const completed = {
  type: "object" as const,
  properties: {
    status: { const: "completed" },
    receipt: { type: "string", minLength: 1 },
  },
  required: ["status", "receipt"],
  additionalProperties: false,
};
export const writeMapping = {
  change: { version: "v1", prepareTool: "preview", receiptTool: "receipt" },
};
export const mcpWriteTools: Tool[] = [
  {
    name: "change",
    description: "Change a value",
    inputSchema: input,
    outputSchema: completed,
    annotations: { readOnlyHint: false },
  },
  {
    name: "preview",
    inputSchema: {
      type: "object",
      properties: { arguments: input },
      required: ["arguments"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { preview: { type: "string" }, version: { type: "string" } },
      required: ["preview", "version"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "receipt",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      oneOf: [
        completed,
        {
          type: "object",
          properties: { status: { const: "unknown" } },
          required: ["status"],
          additionalProperties: false,
        },
      ],
    },
    annotations: { readOnlyHint: true },
  },
];
const metadata = z.strictObject({
  contractVersion: z.literal(1),
  tool: z.literal("change"),
  actorId: z.string(),
  tenantId: z.string(),
  operationId: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
});
export function mcpWriteServer(identity: Identity) {
  const receipts = new Map<string, string>();
  const calls: { name: string; metadata: z.infer<typeof metadata> }[] = [];
  const servers: McpServer[] = [];
  const state = {
    revision: "revision-1",
    effects: 0,
    dropReply: false,
    receiptsAvailable: true,
    afterPrepare: undefined as (() => void) | undefined,
  };
  return {
    state,
    calls,
    async transport() {
      const server = new McpServer(
        { name: "durable-write-fixture", version: "1" },
        { capabilities: { tools: {} } },
      );
      servers.push(server);
      const [client, remote] = InMemoryTransport.createLinkedPair();
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: mcpWriteTools,
      }));
      server.server.setRequestHandler(
        CallToolRequestSchema,
        async (request) => {
          const context = metadata.parse(
            request.params._meta?.["io.yada/action"],
          );
          if (
            context.actorId !== identity.actorId ||
            context.tenantId !== identity.tenantId
          )
            throw new Error("Wrong remote identity");
          const name = request.params.name;
          calls.push({ name, metadata: context });
          const response = (structuredContent: Record<string, unknown>) => ({
            content: [],
            structuredContent,
          });
          if (name === "preview") {
            const args = z
              .strictObject({
                arguments: z.strictObject({ value: z.string() }),
              })
              .parse(request.params.arguments);
            state.afterPrepare?.();
            return response({
              preview: `Change value to ${args.arguments.value}`,
              version: state.revision,
            });
          }
          const id = z.string().min(1).parse(context.operationId);
          if (name === "receipt") {
            z.strictObject({}).parse(request.params.arguments);
            const receipt = state.receiptsAvailable
              ? receipts.get(id)
              : undefined;
            return response(
              receipt === undefined
                ? { status: "unknown" }
                : { status: "completed", receipt },
            );
          }
          if (name !== "change") throw new Error("Unknown tool");
          const args = z
            .strictObject({ value: z.string() })
            .parse(request.params.arguments);
          const saved = receipts.get(id);
          if (saved !== undefined)
            return response({ status: "completed", receipt: saved });
          if (context.version !== state.revision)
            throw new Error("Stale remote state");
          const receipt = `Changed value to ${args.value}`;
          state.effects++;
          receipts.set(id, receipt);
          state.revision = "revision-2";
          if (state.dropReply) await remote.close();
          return response({ status: "completed", receipt });
        },
      );
      await server.connect(remote);
      return client;
    },
    async close() {
      await Promise.all(servers.map((server) => server.close()));
    },
  };
}
