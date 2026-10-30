import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv } from "ajv";
import { z } from "zod";
import type { Identity, ReadTool } from "../../core/contracts.js";
import { abortable } from "../../core/abort.js";
import { mcpConfig, type McpConfig } from "./config.js";
export type McpAccess = Readonly<{
  identity: Identity;
  authorize: (identity: Identity, tool: string) => Promise<boolean>;
}>;
export type McpConnection = Readonly<{
  tools: readonly ReadTool[];
  close: () => Promise<void>;
  isConnected?: () => boolean;
}>;
export async function connectMcpTransport(
  config: McpConfig,
  access: McpAccess,
  transport: Transport,
  signal: AbortSignal,
): Promise<McpConnection> {
  const settings = mcpConfig.parse(config);
  const owner = Object.freeze({ ...access.identity });
  const client = new Client({ name: "yada", version: "0.1.0" });
  let closed = false;
  let connected = false;
  client.onclose = () => {
    connected = false;
  };
  const close = async () => {
    closed = true;
    await client.close();
  };
  try {
    await abortable(() => client.connect(transport), signal);
    connected = true;
    const allowed = settings.readTools
      ? new Set(settings.readTools)
      : undefined;
    const seen = new Set<string>();
    const cursors = new Set<string>();
    const tools: ReadTool[] = [];
    let cursor: string | undefined;
    do {
      if (cursors.size >= 100) throw new Error("MCP discovery limit exceeded");
      const page = await client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: 10_000,
      });
      for (const tool of page.tools) {
        if (seen.has(tool.name)) throw new Error("Duplicate MCP tool");
        seen.add(tool.name);
        if (seen.size > 1000) throw new Error("MCP tool limit exceeded");
        if (
          allowed
            ? !allowed.has(tool.name)
            : tool.annotations?.readOnlyHint !== true
        )
          continue;
        if (tool.annotations?.readOnlyHint === false)
          throw new Error("MCP tool is marked as mutating");
        const name = `${settings.name}__${tool.name}`;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
          throw new Error("Unsupported MCP tool name");
        const validator =
          tool.inputSchema.$schema ===
          "https://json-schema.org/draft/2020-12/schema"
            ? new Ajv2020({ strict: false })
            : new Ajv({ strict: false });
        const validate = validator.compile(tool.inputSchema);
        const authorize = async (identity: Identity) =>
          !closed &&
          identity.actorId === owner.actorId &&
          identity.tenantId === owner.tenantId &&
          access.authorize(identity, tool.name);
        tools.push({
          effect: "read",
          spec: {
            name,
            description: tool.description ?? "",
            parameters: tool.inputSchema,
          },
          authorize,
          async execute(args, identity, callSignal) {
            if (!(await abortable(() => authorize(identity), callSignal)))
              throw new Error("MCP access denied");
            const input = z.record(z.string(), z.unknown()).parse(args);
            if (!validate(input)) throw new Error("Invalid MCP arguments");
            const result = CallToolResultSchema.parse(
              await client.callTool(
                { name: tool.name, arguments: input },
                undefined,
                { signal: callSignal, timeout: 10_000 },
              ),
            );
            if (result.isError) throw new Error("MCP tool failed");
            const output = result.structuredContent
              ? JSON.stringify(result.structuredContent)
              : result.content
                  .map((block) => {
                    if (block.type !== "text")
                      throw new Error("Unsupported MCP content");
                    return block.text;
                  })
                  .join("\n");
            if (output.length > 32_000) throw new Error("MCP result too large");
            return output;
          },
        });
      }
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error("Repeated MCP cursor");
        cursors.add(cursor);
      }
    } while (cursor);
    if (allowed && tools.length !== allowed.size)
      throw new Error("Configured MCP tool not found");
    return { tools, close, isConnected: () => connected && !closed };
  } catch (error) {
    await close();
    throw error;
  }
}
