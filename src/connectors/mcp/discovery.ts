import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export async function discoverMcpTools(
  client: Client,
  signal: AbortSignal,
): Promise<Map<string, Tool>> {
  const tools = new Map<string, Tool>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursors.size >= 100) throw new Error("MCP discovery limit exceeded");
    const page = await client.listTools(cursor ? { cursor } : {}, {
      signal,
      timeout: 10_000,
    });
    for (const tool of page.tools) {
      if (tools.has(tool.name)) throw new Error("Duplicate MCP tool");
      tools.set(tool.name, tool);
      if (tools.size > 1000) throw new Error("MCP tool limit exceeded");
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Repeated MCP cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  return tools;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  if (value === undefined) return "null";
  return JSON.stringify(value);
}
