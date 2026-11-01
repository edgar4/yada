import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  type Tool as RemoteTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Identity, ReadTool, Tool } from "../../core/contracts.js";
import { abortable } from "../../core/abort.js";
import { confirmTool } from "../../core/policy.js";
import {
  mcpConfig,
  type McpConfig,
  type McpReadConfig,
  type McpSettings,
} from "./config.js";
import { canonical, discoverMcpTools } from "./discovery.js";
import { promptApi, resourceTools, type McpPrompt } from "./resources.js";
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
  timeoutMs?: number;
  prompts: (identity: Identity, signal?: AbortSignal) => Promise<McpPrompt[]>;
  getPrompt: (
    identity: Identity,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<string>;
}>;
export const clientVersion = "0.2.0";
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
  return connectParsed(mcpConfig.parse(config), access, transport, signal);
}
export async function connectParsed(
  settings: McpSettings,
  access: McpAccess,
  transport: Transport,
  signal: AbortSignal,
): Promise<McpConnection<Tool>> {
  const owner = Object.freeze({ ...access.identity });
  const client = new Client({ name: "yada", version: clientVersion });
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
    const writes = new Map(Object.entries(settings.writeTools ?? {}));
    const helpers = new Set(
      [...writes.values()].flatMap((mapping) => [
        mapping.prepareTool,
        mapping.receiptTool,
      ]),
    );
    const select = (catalog: Map<string, RemoteTool>) => {
      const required = (name: string) => {
        const tool = catalog.get(name);
        if (!tool) throw new Error("Configured MCP tool not found");
        return tool;
      };
      for (const [name, mapping] of writes) {
        if (required(name).annotations?.readOnlyHint === true)
          throw new Error("MCP write tool is marked as read-only");
        for (const helper of [mapping.prepareTool, mapping.receiptTool])
          if (required(helper).annotations?.readOnlyHint !== true)
            throw new Error("MCP helper is not marked as read-only");
      }
      const listed = Array.isArray(settings.confirmTools)
        ? settings.confirmTools
        : [];
      const reads: RemoteTool[] = [];
      const confirms = listed.map(required);
      for (const tool of catalog.values()) {
        if (
          writes.has(tool.name) ||
          helpers.has(tool.name) ||
          listed.includes(tool.name)
        )
          continue;
        const readOnly = tool.annotations?.readOnlyHint === true;
        if (
          settings.readTools ? settings.readTools.includes(tool.name) : readOnly
        ) {
          if (tool.annotations?.readOnlyHint === false)
            throw new Error("MCP tool is marked as mutating");
          reads.push(tool);
        } else if (settings.confirmTools === "*" && !readOnly)
          confirms.push(tool);
      }
      if (settings.readTools && reads.length !== settings.readTools.length)
        throw new Error("Configured MCP tool not found");
      const selected = [
        ...reads,
        ...confirms,
        ...[...writes.keys(), ...helpers].map(required),
      ];
      return { reads, confirms, selected, required };
    };
    const fingerprint = (tools: readonly RemoteTool[]) =>
      canonical(
        tools
          .map(
            ({
              name,
              description,
              inputSchema,
              outputSchema,
              annotations,
            }) => ({
              name,
              description,
              inputSchema,
              outputSchema,
              annotations,
            }),
          )
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    const { reads, confirms, selected, required } = select(
      await discoverMcpTools(client, signal, settings.timeoutMs),
    );
    const expected = fingerprint(selected);
    let stale = false;
    let checking: Promise<void> = Promise.resolve();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      checking = checking.then(async () => {
        try {
          const next = await discoverMcpTools(
            client,
            AbortSignal.timeout(settings.timeoutMs),
            settings.timeoutMs,
          );
          if (fingerprint(select(next).selected) !== expected) stale = true;
        } catch {
          stale = true;
        }
      });
    });
    const fresh = async () => {
      await checking;
      if (stale)
        throw new Error("MCP tool contract changed; reconnect required");
    };
    const base = mcpInvoker(client, selected, authorize, settings.timeoutMs);
    const rpc = {
      validate: base.validate,
      call: async (...args: Parameters<typeof base.call>) => {
        await fresh();
        return base.call(...args);
      },
      read: async (...args: Parameters<typeof base.read>) => {
        await fresh();
        return base.read(...args);
      },
    };
    const spec = (remote: RemoteTool) => {
      const name = `${settings.name}__${remote.name}`;
      if (name.length > 64)
        throw new Error(
          "MCP tool name exceeds the 64-character limit for server name plus tool name",
        );
      if (!/^[a-zA-Z0-9_-]+$/.test(name))
        throw new Error("Unsupported MCP tool name");
      return {
        name,
        description: remote.description ?? "",
        parameters: remote.inputSchema,
      };
    };
    const read = (remote: RemoteTool): ReadTool => ({
      effect: "read",
      spec: spec(remote),
      authorize: (identity) => authorize(identity, remote.name),
      async execute(args, identity, callSignal) {
        return readResult(
          await rpc.read(remote.name, args, identity, callSignal),
        );
      },
    });
    const tools: Tool[] = [
      ...reads.map(read),
      ...confirms.map((remote) => confirmTool(read(remote))),
    ];
    const writeTools = [...writes].map(([name, mapping]) => {
      const remote = required(name);
      return mcpWriteTool({
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
      });
    });
    if (settings.resources) {
      const extra = resourceTools(settings.name, {
        client,
        timeout: settings.timeoutMs,
        authorize,
        fresh,
      });
      const names = new Set(
        [...tools, ...writeTools].map((tool) => tool.spec.name),
      );
      if (extra.some((tool) => names.has(tool.spec.name)))
        throw new Error("MCP resource tool name conflicts with a remote tool");
      tools.push(...extra);
    }
    tools.push(...writeTools);
    return {
      tools,
      close,
      isConnected: () => connected && !closed && !stale,
      timeoutMs: settings.timeoutMs,
      ...promptApi({
        client,
        timeout: settings.timeoutMs,
        authorize,
        fresh,
      }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
