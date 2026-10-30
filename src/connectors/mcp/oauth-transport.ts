import { AsyncLocalStorage } from "node:async_hooks";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpOAuth } from "./oauth.js";

async function safe<T>(operation: () => Promise<T>): Promise<T> {
  let unauthorized: boolean;
  try {
    return await operation();
  } catch (error) {
    unauthorized = error instanceof UnauthorizedError;
  }
  if (unauthorized) throw new UnauthorizedError();
  throw new Error("MCP OAuth request failed");
}

export function coordinateOAuthTransport(
  transport: StreamableHTTPClientTransport,
  oauth: McpOAuth,
): void {
  const coordinate = oauth.coordinate;
  if (!coordinate) return;
  const send = transport.send.bind(transport);
  transport.send = (message, options) =>
    safe(() => coordinate(() => send(message, options)));
  // SDK 1.32.2 has no public hook for authentication during background SSE reconnects.
  const background = transport as unknown as {
    _startOrAuthSse?: (...args: unknown[]) => Promise<void>;
  };
  if (typeof background._startOrAuthSse !== "function")
    throw new Error("Unsupported MCP OAuth transport");
  const start = background._startOrAuthSse.bind(transport);
  const context = new AsyncLocalStorage<{ active: boolean }>();
  background._startOrAuthSse = (...args) => {
    if (context.getStore()?.active) return start(...args);
    return safe(() =>
      coordinate(
        () => {
          const scope = { active: true };
          return context.run(scope, async () => {
            try {
              await start(...args);
            } finally {
              scope.active = false;
            }
          });
        },
        undefined,
        true,
      ),
    );
  };
}
