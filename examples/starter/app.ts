import {
  connectMcp,
  createHandler,
  createProvider,
  createWorker,
  reconnectingMcp,
  type McpConnection,
  type ProviderAdapter,
  type Tool,
  type YadaStorage,
} from "@edgaralochi/yada";
import { createStarterAuth, starterIdentity } from "./auth.js";
import type { StarterConfig } from "./config.js";
import { starterTools } from "./tools.js";

export type StarterAssets = Readonly<
  Record<"/" | "/assets/client.js" | "/assets/style.css", string>
>;

export async function createStarterApp(options: {
  config: StarterConfig;
  storage: YadaStorage;
  assets: StarterAssets;
  provider?: ProviderAdapter;
}) {
  const { config, storage } = options;
  const auth = createStarterAuth({
    password: config.password,
    sessionKey: config.storage.encryptionKey,
    origin: config.origin,
  });
  const connections: McpConnection<Tool>[] = [];
  const owns = (identity: typeof starterIdentity) =>
    Promise.resolve(
      identity.actorId === starterIdentity.actorId &&
        identity.tenantId === starterIdentity.tenantId,
    );
  try {
    const provider = options.provider ?? createProvider(config.provider);
    for (const server of config.servers)
      connections.push(
        await reconnectingMcp((signal) =>
          connectMcp(
            server,
            { identity: starterIdentity, authorize: owns },
            signal,
          ),
        ),
      );
    const worker = createWorker({
      storage,
      profiles: {
        starter: {
          provider,
          tools: [
            ...starterTools(starterIdentity),
            ...connections.flatMap((connection) => connection.tools),
          ],
          system:
            "You are Yada, a helpful assistant for the signed-in user. Use the available tools when needed. Explain approval requests clearly. Never claim an action succeeded without its tool result.",
          maxRounds: 8,
          maxToolCalls: 16,
          timeoutMs: 60_000,
        },
      },
    });
    const api = createHandler({
      storage,
      origins: [config.origin],
      authenticate: auth.authenticate,
      authorizeProfile: (identity, profile) =>
        Promise.resolve(
          profile === "starter" &&
            identity.actorId === starterIdentity.actorId &&
            identity.tenantId === starterIdentity.tenantId,
        ),
    });
    const types = {
      "/": "text/html; charset=utf-8",
      "/assets/client.js": "text/javascript; charset=utf-8",
      "/assets/style.css": "text/css; charset=utf-8",
    };
    const route = async (request: Request): Promise<Response> => {
      const authenticated = await auth.handle(request);
      if (authenticated) return authenticated;
      const path = new URL(request.url).pathname;
      if (path.startsWith("/v1/")) return api(request);
      if (
        Object.hasOwn(types, path) &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const asset = path as keyof StarterAssets;
        return new Response(
          request.method === "HEAD" ? null : options.assets[asset],
          { headers: { "content-type": types[asset] } },
        );
      }
      return new Response("Not found", { status: 404 });
    };
    return {
      worker,
      async handle(request: Request): Promise<Response> {
        const response = await route(request);
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store");
        headers.set("x-content-type-options", "nosniff");
        headers.set("referrer-policy", "no-referrer");
        headers.set(
          "content-security-policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        );
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      },
      async close() {
        const stopped = await Promise.allSettled([worker.stop()]);
        const disconnected = await Promise.allSettled(
          connections.map((connection) => connection.close()),
        );
        if (
          [...stopped, ...disconnected].some(
            (result) => result.status === "rejected",
          )
        )
          throw new Error("Starter shutdown failed");
      },
    };
  } catch (error) {
    await Promise.allSettled(
      connections.map((connection) => connection.close()),
    );
    throw error;
  }
}
