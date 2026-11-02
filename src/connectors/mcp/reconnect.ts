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
  const deadline = () => AbortSignal.timeout(current.timeoutMs ?? 10_000);
  const isClosed = () => closed;
  let pending: Promise<void> | undefined;
  let failure: { error: unknown; until: number } | undefined;
  async function ready(callSignal: AbortSignal) {
    callSignal.throwIfAborted();
    if (closed) throw new Error("MCP connection closed");
    if (current.isConnected?.() === false) {
      if (failure && Date.now() < failure.until) throw failure.error;
      pending ??= (async () => {
        try {
          await current.close();
          const next = await connect(deadline());
          if (isClosed() || contract(next) !== expected) {
            await next.close();
            throw new Error("MCP discovery changed");
          }
          current = next;
          failure = undefined;
        } catch (error) {
          failure = { error, until: Date.now() + 30_000 };
          throw error;
        }
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
      await ready(deadline());
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
        ...(original.reconcile
          ? {
              reconcile: (id, identity, callSignal) =>
                invoke(identity, callSignal, async () =>
                  write().reconcile?.(id, identity, callSignal),
                ),
            }
          : {}),
      };
    }
    return {
      effect: "read",
      spec: original.spec,
      authorize,
      execute: (args, identity, callSignal, run) =>
        invoke(identity, callSignal, () => {
          const tool = find();
          if (tool.effect !== "read") throw new Error("MCP tool changed");
          return tool.execute(args, identity, callSignal, run);
        }),
    };
  });
  return {
    tools,
    ...(current.skipped ? { skipped: current.skipped } : {}),
    isConnected: () => !closed && (current.isConnected?.() ?? true),
    prompts: async (identity, callSignal) => {
      await ready(callSignal ?? deadline());
      return current.prompts(identity, callSignal);
    },
    getPrompt: async (identity, name, args, callSignal) => {
      await ready(callSignal ?? deadline());
      return current.getPrompt(identity, name, args, callSignal);
    },
    async close() {
      closed = true;
      await current.close();
      await pending?.catch(() => undefined);
    },
  };
}
