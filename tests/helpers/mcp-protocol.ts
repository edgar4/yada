import { vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  connectMcpTransport,
  type McpAccess,
  type McpConnection,
} from "../../src/connectors/mcp/session.js";
import type {
  McpConfig,
  Tool as AgentTool,
  WriteTool,
} from "../../src/index.js";
import { mcpWriteTools, writeMapping } from "./mcp-write-server.js";

export const owner = { actorId: "actor", tenantId: "tenant" };
export const writeConfig = {
  name: "remote",
  url: "https://example.test/mcp",
  writeTools: writeMapping,
};
export function mutation(connection: McpConnection<AgentTool>): WriteTool {
  const tool = connection.tools.find(
    (candidate) => candidate.effect === "write",
  );
  if (!tool) throw new Error("Missing write tool");
  return tool;
}
export function protocolServer(
  options: { tools?: Tool[]; pageSize?: number } = {},
) {
  const tools = structuredClone(options.tools ?? mcpWriteTools);
  const server = new McpServer(
    { name: "protocol-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  const calls = vi.fn<
    (params: CallToolRequest["params"]) => Promise<CallToolResult>
  >((params) =>
    Promise.resolve({
      content: [],
      structuredContent:
        params.name === "preview"
          ? { preview: "Change", version: "state-1" }
          : params.name === "receipt"
            ? { status: "unknown" }
            : { status: "completed", receipt: "receipt-1" },
    }),
  );
  const authorize = vi.fn<McpAccess["authorize"]>().mockResolvedValue(true);
  server.server.setRequestHandler(CallToolRequestSchema, (request) =>
    calls(request.params),
  );
  server.server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const start = Number(request.params?.cursor ?? 0);
    const end = start + (options.pageSize ?? tools.length);
    return {
      tools: tools.slice(start, end),
      ...(end < tools.length ? { nextCursor: String(end) } : {}),
    };
  });
  let connection: McpConnection<AgentTool> | undefined;
  return {
    server,
    tools,
    calls,
    authorize,
    async connect(config: McpConfig = writeConfig) {
      const [client, remote] = InMemoryTransport.createLinkedPair();
      await server.connect(remote);
      connection = await connectMcpTransport(
        config,
        { identity: owner, authorize },
        client,
        AbortSignal.timeout(5000),
      );
      return connection;
    },
    async close() {
      await connection?.close();
      await server.close();
    },
  };
}
