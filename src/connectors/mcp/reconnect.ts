import type { McpConnection } from "./session.js";
import type { Identity, Tool } from "../../core/contracts.js";
import { abortable } from "../../core/abort.js";
import { canonical } from "./discovery.js";

function contract(connection: McpConnection<Tool>): string {
  return canonical(
    connection.tools
      .map((tool) => ({
        effect: tool.effect,
        spec: tool.spec,
        ...(tool.effect === "write" ? { version: tool.version } : {}),
      }))
      .sort((a, b) => a.spec.name.localeCompare(b.spec.name)),
  );
}
export function reconnectingMcp(
  connect: (signal: AbortSignal) => Promise<McpConnection>,
  signal?: AbortSignal,
): Promise<McpConnection>;
export function reconnectingMcp(
  connect: (signal: AbortSignal) => Promise<McpConnection<Tool>>,
  signal?: AbortSignal,
): Promise<McpConnection<Tool>>;
export async function reconnectingMcp(
  connect: (signal: AbortSignal) => Promise<McpConnection<Tool>>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<McpConnection<Tool>> {
  let current = await connect(signal);
  const expected = contract(current);
  let closed = false;
  const isClosed = () => closed;
  let pending: Promise<void> | undefined;
  async function ready(callSignal: AbortSignal) {
    callSignal.throwIfAborted();
    if (closed) throw new Error("MCP connection closed");
    if (current.isConnected?.() === false) {
      pending ??= (async () => {
        await current.close();
        const next = await connect(AbortSignal.timeout(10_000));
        if (isClosed() || contract(next) !== expected) {
          await next.close();
          throw new Error("MCP discovery changed");
        }
        current = next;
      })().finally(() => {
        pending = undefined;
      });
      const connecting = pending;
      await abortable(() => connecting, callSignal);
    }
  }
  const tools: Tool[] = current.tools.map((original) => {
    const find = () => {
      const tool = current.tools.find(
        (tool) => tool.spec.name === original.spec.name,
      );
      if (!tool || tool.effect !== original.effect)
        throw new Error("MCP tool changed");
      return tool;
    };
    const authorize = async (identity: Identity) => {
      if (closed) return false;
      await ready(AbortSignal.timeout(10_000));
      return find().authorize(identity);
    };
    async function invoke<T>(
      identity: Identity,
      callSignal: AbortSignal,
      operation: () => Promise<T>,
    ): Promise<T> {
      await ready(callSignal);
      if (!(await abortable(() => find().authorize(identity), callSignal)))
        throw new Error("MCP access denied");
      return operation();
    }
    if (original.effect === "write") {
      const write = () => {
        const tool = find();
        if (tool.effect !== "write") throw new Error("MCP tool changed");
        return tool;
      };
      return {
        effect: "write",
        spec: original.spec,
        version: original.version,
        authorize,
        prepare: (args, identity, callSignal) =>
          invoke(identity, callSignal, () =>
            write().prepare(args, identity, callSignal),
          ),
        execute: (args, context) =>
          invoke(context.identity, context.signal, () =>
            write().execute(args, context),
          ),
        reconcile: (id, identity, callSignal) =>
          invoke(identity, callSignal, () =>
            write().reconcile(id, identity, callSignal),
          ),
      };
    }
    return {
      effect: "read",
      spec: original.spec,
      authorize,
      execute: (args, identity, callSignal) =>
        invoke(identity, callSignal, () => {
          const tool = find();
          if (tool.effect !== "read") throw new Error("MCP tool changed");
          return tool.execute(args, identity, callSignal);
        }),
    };
  });
  return {
    tools,
    isConnected: () => !closed && (current.isConnected?.() ?? true),
    async close() {
      closed = true;
      await current.close();
      await pending?.catch(() => undefined);
    },
  };
}
