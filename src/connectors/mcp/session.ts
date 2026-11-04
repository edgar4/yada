import type { ActionContext } from "../../core/action.js";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  type Tool as RemoteTool,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Identity,
  ProviderAdapter,
  ReadTool,
  Tool,
} from "../../core/contracts.js";
import { abortable } from "../../core/abort.js";
import { confirmTool } from "../../core/policy.js";
import { ToolCallError } from "../../core/tool.js";
import {
  mcpConfig,
  type McpConfig,
  type McpReadConfig,
  type McpSettings,
} from "./config.js";
import { clientRequests } from "./client-requests.js";
import { canonical, discoverMcpTools } from "./discovery.js";
import { promptApi, resourceTools, type McpPrompt } from "./resources.js";
import { mcpInvoker, readResult } from "./rpc.js";
import { injectArguments, mcpWriteTool } from "./write.js";
export type McpAccess = Readonly<{
  identity: Identity;
  authorize: (identity: Identity, tool: string) => Promise<boolean>;
  provider?: ProviderAdapter;
}>;
export type McpConnection<T extends Tool = ReadTool> = Readonly<{
  tools: readonly T[];
  skipped?: readonly Readonly<{ tool: string; reason: string }>[];
  toolNames?: ReadonlyMap<string, string>;
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
export const clientVersion = (() => {
  try {
    return (
      createRequire(import.meta.url)("../../../package.json") as {
        version: string;
      }
    ).version;
  } catch {
    return "unknown";
  }
})();
export const exposedToolName = (server: string, tool: string) =>
  `${server}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const warnedServers = new Set<string>();
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
  const client = new Client(
    { name: "yada", version: clientVersion },
    settings.sampling || settings.elicitation
      ? {
          capabilities: {
            ...(settings.sampling ? { sampling: {} } : {}),
            ...(settings.elicitation ? { elicitation: { form: {} } } : {}),
          },
        }
      : undefined,
  );
  const within = clientRequests(client, settings, access.provider);
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
        if (!tool) throw new Error(`Configured MCP tool not found: ${name}`);
        return tool;
      };
      for (const [name, mapping] of writes) {
        if (required(name).annotations?.readOnlyHint === true)
          throw new Error(`MCP write tool is marked as read-only: ${name}`);
        for (const helper of [mapping.prepareTool, mapping.receiptTool])
          if (required(helper).annotations?.readOnlyHint !== true)
            throw new Error(`MCP helper is not marked as read-only: ${helper}`);
      }
      const listed = Array.isArray(settings.confirmTools)
        ? settings.confirmTools
        : [];
      const reads: RemoteTool[] = [];
      const skipped: { tool: string; reason: string }[] = [];
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
            throw new Error(`MCP tool is marked as mutating: ${tool.name}`);
          reads.push(tool);
        } else if (settings.confirmTools === "*" && !readOnly)
          confirms.push(tool);
        else
          skipped.push({
            tool: tool.name,
            reason: settings.readTools
              ? "not listed in readTools"
              : "not annotated readOnlyHint: true; add it to readTools or confirmTools",
          });
      }
      const missing = settings.readTools?.find((name) => !catalog.has(name));
      if (missing) throw new Error(`Configured MCP tool not found: ${missing}`);
      const selected = [
        ...reads,
        ...confirms,
        ...[...writes.keys(), ...helpers].map(required),
      ];
      return { reads, confirms, selected, required, skipped };
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
    const { reads, confirms, selected, required, skipped } = select(
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
        throw new ToolCallError(
          "MCP tool contract changed; reconnect required",
          "request_failed",
          "not_sent",
        );
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
    const hidden = settings.hiddenArguments ?? {};
    const hiddenFor = (name: string) =>
      Object.hasOwn(hidden, name) ? hidden[name] : undefined;
    for (const [name, args] of Object.entries(hidden)) {
      if (!confirms.some((tool) => tool.name === name) && !writes.has(name))
        throw new Error(`MCP hidden arguments need a write tool: ${name}`);
      const { properties } = required(name).inputSchema;
      if (args.some((arg) => !properties || !Object.hasOwn(properties, arg)))
        throw new Error(`Unknown MCP hidden argument on ${name}`);
    }
    const visibleSchema = ({ name, inputSchema }: RemoteTool) => {
      const names = hiddenFor(name);
      if (!names) return inputSchema;
      const { properties, required: needed, ...rest } = inputSchema;
      return {
        ...rest,
        properties: Object.fromEntries(
          Object.entries(properties ?? {}).filter(
            ([key]) => !names.includes(key),
          ),
        ),
        ...(needed
          ? { required: needed.filter((key) => !names.includes(key)) }
          : {}),
      };
    };
    const confirm = (remote: RemoteTool): Tool => {
      const tool = confirmTool(read(remote));
      const names = hiddenFor(remote.name);
      return names
        ? {
            ...tool,
            execute: (args: unknown, context: ActionContext) =>
              tool.execute(
                injectArguments(names, args, context.operationId),
                context,
              ),
          }
        : tool;
    };
    const exposed = new Map<string, string>();
    const spec = (remote: RemoteTool) => {
      let name = exposed.get(remote.name);
      if (!name) {
        const base = exposedToolName(settings.name, remote.name);
        name = base;
        for (let n = 2; [...exposed.values()].includes(name); n++)
          name = `${base}_${String(n)}`;
        exposed.set(remote.name, name);
      }
      if (name.length > 64)
        throw new Error(
          `MCP tool name exceeds the 64-character limit for server name plus tool name: ${remote.name}`,
        );
      return {
        name,
        description: remote.description ?? "",
        parameters: visibleSchema(remote),
      };
    };
    const read = (remote: RemoteTool): ReadTool => ({
      effect: "read",
      spec: spec(remote),
      authorize: (identity) => authorize(identity, remote.name),
      async execute(args, identity, callSignal, run) {
        return readResult(
          await within(run, () =>
            rpc.read(remote.name, args, identity, callSignal),
          ),
        );
      },
    });
    const tools: Tool[] = [...reads.map(read), ...confirms.map(confirm)];
    const writeTools = [...writes].map(([name, mapping]) => {
      const remote = required(name);
      const hiddenNames = hiddenFor(name);
      return mcpWriteTool({
        config: settings,
        mapping,
        remote,
        prepare: required(mapping.prepareTool),
        receipt: required(mapping.receiptTool),
        spec: spec(remote),
        ...(hiddenNames ? { hidden: hiddenNames } : {}),
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
    if (
      !settings.readTools &&
      skipped.length &&
      !warnedServers.has(settings.name)
    ) {
      warnedServers.add(settings.name);
      console.warn(
        `MCP server "${settings.name}" did not expose ${String(skipped.length)} tool(s); set readTools or confirmTools to expose them:\n${skipped.map((item) => `  ${item.tool}: ${item.reason}`).join("\n")}`,
      );
    }
    return {
      tools,
      skipped,
      toolNames: new Map([...exposed].map(([remote, name]) => [name, remote])),
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
