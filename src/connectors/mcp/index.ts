import type { McpOAuth } from "./oauth.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  hasAuthorizationHeader,
  mcpConfig,
  type McpConfig,
  type McpReadConfig,
} from "./config.js";
import {
  connectParsed,
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
      hasAuthorizationHeader(settings.headers) ||
      new URL(settings.url).href !== oauth.serverUrl ||
      access.identity.actorId !== oauth.identity.actorId ||
      access.identity.tenantId !== oauth.identity.tenantId)
  )
    throw new Error("OAuth connection mismatch");
  if (!("url" in settings))
    return connectParsed(
      settings,
      access,
      new StdioClientTransport({
        command: settings.command,
        args: settings.args,
        stderr: settings.stderr,
        ...(settings.env ? { env: settings.env } : {}),
        ...(settings.cwd ? { cwd: settings.cwd } : {}),
      }),
      signal,
    );
  const endpoint = new URL(settings.url);
  const guardedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    const target = input instanceof Request ? input.url : String(input);
    if (new URL(target).origin === endpoint.origin) {
      for (const [name, value] of Object.entries(settings.headers ?? {}))
        headers.set(name, value);
      if (settings.token)
        headers.set("authorization", `Bearer ${settings.token}`);
    }
    const signals = [
      init?.signal,
      target === endpoint.href ? undefined : oauth?.signal?.(),
    ].filter(
      (value): value is AbortSignal => value !== undefined && value !== null,
    );
    return fetch(input, {
      ...init,
      headers,
      redirect: "error",
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    });
  };
  const streamable = new StreamableHTTPClientTransport(endpoint, {
    ...(oauth ? { authProvider: oauth.provider } : {}),
    fetch: guardedFetch,
  });
  if (oauth) coordinateOAuthTransport(streamable, oauth);
  try {
    return await connectParsed(settings, access, streamable, signal);
  } catch (error) {
    const code = error instanceof StreamableHTTPError ? (error.code ?? 0) : 0;
    if (oauth || code < 400 || code >= 500 || code === 401 || code === 403)
      throw error;
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy servers only speak SSE
  const legacy = new SSEClientTransport(endpoint, {
    fetch: guardedFetch,
    eventSourceInit: { fetch: guardedFetch },
  });
  return connectParsed(settings, access, legacy, signal);
}
