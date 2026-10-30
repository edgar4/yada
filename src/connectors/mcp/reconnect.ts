import type { McpConnection } from "./session.js";
import type { Identity, ReadTool } from "../../core/contracts.js";
import { abortable } from "../../core/abort.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function reconnectingMcp(
  connect: (signal: AbortSignal) => Promise<McpConnection>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<McpConnection> {
  let current = await connect(signal);
  const expected = canonical(
    current.tools
      .map((tool) => tool.spec)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
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
        if (
          isClosed() ||
          canonical(
            next.tools
              .map((tool) => tool.spec)
              .sort((a, b) => a.name.localeCompare(b.name)),
          ) !== expected
        ) {
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
  const tools: ReadTool[] = current.tools.map((original) => {
    const find = () => {
      const tool = current.tools.find(
        (tool) => tool.spec.name === original.spec.name,
      );
      if (!tool) throw new Error("MCP tool missing");
      return tool;
    };
    return {
      effect: "read",
      spec: original.spec,
      async authorize(identity: Identity) {
        if (closed) return false;
        await ready(AbortSignal.timeout(10_000));
        return find().authorize(identity);
      },
      async execute(args, identity, callSignal) {
        await ready(callSignal);
        const tool = find();
        if (!(await abortable(() => tool.authorize(identity), callSignal)))
          throw new Error("MCP access denied");
        return tool.execute(args, identity, callSignal);
      },
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
