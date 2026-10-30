import type { McpOAuth } from "./oauth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpConfig, type McpConfig } from "./config.js";
import { connectMcpTransport, type McpAccess } from "./session.js";
import { coordinateOAuthTransport } from "./oauth-transport.js";
export type { McpConfig } from "./config.js";
export type { McpAccess, McpConnection } from "./session.js";
export async function connectMcp(
  config: McpConfig,
  access: McpAccess,
  signal: AbortSignal = AbortSignal.timeout(10_000),
  oauth?: McpOAuth,
) {
  const settings = mcpConfig.parse(config);
  if (
    oauth &&
    (!("url" in settings) ||
      settings.token ||
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
            if (settings.token)
              headers.set("authorization", `Bearer ${settings.token}`);
            const endpoint =
              input instanceof Request ? input.url : String(input);
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
          stderr: "ignore",
        });
  if (oauth && transport instanceof StreamableHTTPClientTransport)
    coordinateOAuthTransport(transport, oauth);
  return connectMcpTransport(settings, access, transport, signal);
}
