import type { McpOAuth } from "./oauth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpConfig, type McpConfig, type McpReadConfig } from "./config.js";
import {
  connectMcpTransport,
  type McpAccess,
  type McpConnection,
} from "./session.js";
import type { Tool } from "../../core/contracts.js";
import { coordinateOAuthTransport } from "./oauth-transport.js";
export type { McpConfig, McpReadConfig, McpWriteMapping } from "./config.js";
export type { McpAccess, McpConnection } from "./session.js";
export type { McpPrompt } from "./resources.js";
export function connectMcp(
  config: McpReadConfig,
  access: McpAccess,
  signal?: AbortSignal,
  oauth?: McpOAuth,
): Promise<McpConnection>;
export function connectMcp(
  config: McpConfig,
  access: McpAccess,
  signal?: AbortSignal,
  oauth?: McpOAuth,
): Promise<McpConnection<Tool>>;
export async function connectMcp(
  config: McpConfig,
  access: McpAccess,
  signal?: AbortSignal,
  oauth?: McpOAuth,
): Promise<McpConnection<Tool>> {
  const settings = mcpConfig.parse(config);
  signal ??= AbortSignal.timeout(settings.timeoutMs);
  if (
    oauth &&
    (!("url" in settings) ||
      settings.token ||
      Object.keys(settings.headers ?? {}).some(
        (name) => name.toLowerCase() === "authorization",
      ) ||
      new URL(settings.url).href !== oauth.serverUrl ||
      access.identity.actorId !== oauth.identity.actorId ||
      access.identity.tenantId !== oauth.identity.tenantId)
  )
    throw new Error("OAuth connection mismatch");
  const transport =
    "url" in settings
      ? new StreamableHTTPClientTransport(new URL(settings.url), {
          ...(oauth ? { authProvider: oauth.provider } : {}),
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            const endpoint =
              input instanceof Request ? input.url : String(input);
            if (new URL(endpoint).origin === new URL(settings.url).origin) {
              for (const [name, value] of Object.entries(
                settings.headers ?? {},
              ))
                headers.set(name, value);
              if (settings.token)
                headers.set("authorization", `Bearer ${settings.token}`);
            }
            const signals = [
              init?.signal,
              endpoint === new URL(settings.url).href
                ? undefined
                : oauth?.signal?.(),
            ].filter(
              (value): value is AbortSignal =>
                value !== undefined && value !== null,
            );
            return fetch(input, {
              ...init,
              headers,
              redirect: "error",
              ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
            });
          },
        })
      : new StdioClientTransport({
          command: settings.command,
          args: settings.args,
          stderr: settings.stderr,
          ...(settings.env ? { env: settings.env } : {}),
          ...(settings.cwd ? { cwd: settings.cwd } : {}),
        });
  if (oauth && transport instanceof StreamableHTTPClientTransport)
    coordinateOAuthTransport(transport, oauth);
  return connectMcpTransport(settings, access, transport, signal);
}
