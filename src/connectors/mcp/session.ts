import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as RemoteTool } from "@modelcontextprotocol/sdk/types.js";
import type { Identity, ReadTool, Tool } from "../../core/contracts.js";
import { abortable } from "../../core/abort.js";
import { mcpConfig, type McpConfig, type McpReadConfig } from "./config.js";
import { discoverMcpTools } from "./discovery.js";
import { mcpInvoker, readResult } from "./rpc.js";
import { mcpWriteTool } from "./write.js";
export type McpAccess = Readonly<{
  identity: Identity;
  authorize: (identity: Identity, tool: string) => Promise<boolean>;
}>;
export type McpConnection<T extends Tool = ReadTool> = Readonly<{
  tools: readonly T[];
  close: () => Promise<void>;
  isConnected?: () => boolean;
}>;
export function connectMcpTransport(
  config: McpReadConfig,
  access: McpAccess,
  transport: Transport,
  signal: AbortSignal,
): Promise<McpConnection>;
export function connectMcpTransport(
  config: McpConfig,
  access: McpAccess,
  transport: Transport,
  signal: AbortSignal,
): Promise<McpConnection<Tool>>;
export async function connectMcpTransport(
  config: McpConfig,
  access: McpAccess,
  transport: Transport,
  signal: AbortSignal,
): Promise<McpConnection<Tool>> {
  const settings = mcpConfig.parse(config);
  const owner = Object.freeze({ ...access.identity });
  const client = new Client({ name: "yada", version: "0.2.0" });
  let closed = false;
  let connected = false;
  client.onclose = () => {
    connected = false;
  };
  const close = async () => {
    closed = true;
    await client.close();
  };
  const authorize = async (identity: Identity, name: string) =>
    !closed &&
    identity.actorId === owner.actorId &&
    identity.tenantId === owner.tenantId &&
    access.authorize(identity, name);
  try {
    await abortable(() => client.connect(transport), signal);
    connected = true;
    const catalog = await discoverMcpTools(client, signal);
    const required = (name: string) => {
      const tool = catalog.get(name);
      if (!tool) throw new Error("Configured MCP tool not found");
      return tool;
    };
    const writes = new Map(Object.entries(settings.writeTools ?? {}));
    const helpers = new Set(
      [...writes.values()].flatMap((mapping) => [
        mapping.prepareTool,
        mapping.receiptTool,
      ]),
    );
    for (const [name, mapping] of writes) {
      if (required(name).annotations?.readOnlyHint === true)
        throw new Error("MCP write tool is marked as read-only");
      for (const helper of [mapping.prepareTool, mapping.receiptTool])
        if (required(helper).annotations?.readOnlyHint !== true)
          throw new Error("MCP helper is not marked as read-only");
    }
    const reads: RemoteTool[] = [];
    for (const tool of catalog.values()) {
      if (writes.has(tool.name) || helpers.has(tool.name)) continue;
      if (
        settings.readTools
          ? !settings.readTools.includes(tool.name)
          : tool.annotations?.readOnlyHint !== true
      )
        continue;
      if (tool.annotations?.readOnlyHint === false)
        throw new Error("MCP tool is marked as mutating");
      reads.push(tool);
    }
    if (settings.readTools && reads.length !== settings.readTools.length)
      throw new Error("Configured MCP tool not found");
    const selected = [
      ...reads,
      ...[...writes.keys(), ...helpers].map(required),
    ];
    const rpc = mcpInvoker(client, selected, authorize);
    const spec = (remote: RemoteTool) => {
      const name = `${settings.name}__${remote.name}`;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
        throw new Error("Unsupported MCP tool name");
      return {
        name,
        description: remote.description ?? "",
        parameters: remote.inputSchema,
      };
    };
    const tools: Tool[] = reads.map((remote) => ({
      effect: "read",
      spec: spec(remote),
      authorize: (identity) => authorize(identity, remote.name),
      async execute(args, identity, callSignal) {
        return readResult(
          await rpc.call(remote.name, args, identity, callSignal),
        );
      },
    }));
    for (const [name, mapping] of writes) {
      const remote = required(name);
      tools.push(
        mcpWriteTool({
          config: settings,
          mapping,
          remote,
          prepare: required(mapping.prepareTool),
          receipt: required(mapping.receiptTool),
          spec: spec(remote),
          owner,
          authorize,
          invoke: rpc.call,
          validate: rpc.validate,
        }),
      );
    }
    return { tools, close, isConnected: () => connected && !closed };
  } catch (error) {
    await close();
    throw error;
  }
}
