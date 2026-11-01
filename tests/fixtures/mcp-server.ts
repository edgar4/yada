import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fixture", version: "1" });
server.registerTool(
  "lookup",
  { inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  ({ id }) => ({ content: [{ type: "text", text: `Found ${id}` }] }),
);
const readOnly = { annotations: { readOnlyHint: true } };
server.registerTool("context", readOnly, () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        env: process.env["YADA_TEST"],
        cwd: process.cwd(),
      }),
    },
  ],
}));
server.registerTool("fail", readOnly, () => ({
  isError: true,
  content: [{ type: "text", text: "boom" }],
}));
server.registerTool("mixed", readOnly, () => ({
  content: [
    { type: "text", text: "a" },
    { type: "image", data: "AA==", mimeType: "image/png" },
    { type: "audio", data: "AA==", mimeType: "audio/wav" },
    { type: "resource", resource: { uri: "file:///x", text: "t" } },
    { type: "resource_link", uri: "file:///y", name: "why" },
  ],
}));
server.registerTool("slow", readOnly, () => new Promise(() => undefined));
await server.connect(new StdioServerTransport());
