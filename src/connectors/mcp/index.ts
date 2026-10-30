import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpConfig, type McpConfig } from "./config.js";
import { connectMcpTransport, type McpAccess } from "./session.js";
export type { McpConfig } from "./config.js";
export type { McpAccess, McpConnection } from "./session.js";
export async function connectMcp(
  config: McpConfig,
  access: McpAccess,
  signal: AbortSignal = AbortSignal.timeout(10_000),
) {
  const settings = mcpConfig.parse(config);
  const transport =
    "url" in settings
      ? new StreamableHTTPClientTransport(new URL(settings.url), {
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            if (settings.token)
              headers.set("authorization", `Bearer ${settings.token}`);
            return fetch(input, { ...init, headers, redirect: "error" });
          },
        })
      : new StdioClientTransport({
          command: settings.command,
          args: settings.args,
          stderr: "ignore",
        });
  return connectMcpTransport(settings, access, transport, signal);
}
