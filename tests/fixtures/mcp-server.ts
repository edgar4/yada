import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fixture", version: "1" });
server.registerTool(
  "lookup",
  { inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  ({ id }) => ({ content: [{ type: "text", text: `Found ${id}` }] }),
);
await server.connect(new StdioServerTransport());
