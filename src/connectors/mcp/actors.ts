import { createHash } from "node:crypto";
import {
  auth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { z } from "zod";
import { abortable } from "../../core/abort.js";
import type { Identity, ReadTool, Tool } from "../../core/contracts.js";
import { ToolCallError } from "../../core/tool.js";
import type { ActionContext, WriteTool } from "../../core/action.js";
import type { McpConfig } from "./config.js";
import { connectMcp } from "./index.js";
import { createMcpOAuth, oauthRecordKey, type McpOAuthStore } from "./oauth.js";
import { reconnectingMcp } from "./reconnect.js";
import { mcpAccessDenied } from "./rpc.js";
import type { McpAccess, McpConnection } from "./session.js";

const anonymous = Object.freeze({ tenantId: "", actorId: "anonymous" });
const stateTtlMs = 600_000;
const identitySchema = z.object({ tenantId: z.string(), actorId: z.string() });
const notConnected = () =>
  new ToolCallError(
    "Account not connected; the user must connect it before this tool can run.",
    "not_connected",
    "not_sent",
  );
const stateKey = (state: string) =>
  JSON.stringify([
    "connect-state",
    createHash("sha256").update(state).digest("hex"),
  ]);
type Entry = {
  connection: Promise<McpConnection<Tool>>;
  active: number;
  usedAt: number;
  timer?: NodeJS.Timeout;
};

export async function createMcpActorPool(options: {
  config: Extract<McpConfig, { url: string }>;
  redirectUrl: string;
  store: McpOAuthStore;
  authorize: McpAccess["authorize"];
  publicTools?: readonly string[];
  idleMs?: number;
  maxConnections?: number;
  provider?: McpAccess["provider"];
  client?: Pick<
    Parameters<typeof createMcpOAuth>[0],
    "clientId" | "clientSecret" | "clientAuthMethod" | "clientMetadataUrl"
  >;
  signal?: AbortSignal;
}) {
  const {
    config,
    store,
    redirectUrl,
    publicTools = [],
    idleMs = 300_000,
    maxConnections = 100,
  } = options;
  const actorConfig: McpConfig = {
    ...config,
    token: undefined,
    headers: Object.fromEntries(
      Object.entries(config.headers ?? {}).filter(
        ([name]) => name.toLowerCase() !== "authorization",
      ),
    ),
  };
  const provider = options.provider ? { provider: options.provider } : {};
  const serverUrl = new URL(config.url).href;
  const oauthFor = (
    identity: Identity,
    redirect: (url: URL) => Promise<void> = () => Promise.resolve(),
  ) =>
    createMcpOAuth({
      serverUrl,
      redirectUrl,
      identity,
      store,
      redirect,
      ...options.client,
    });
  const catalog = await reconnectingMcp(
    (signal) =>
      connectMcp(
        config,
        {
          identity: anonymous,
          authorize: () => Promise.resolve(true),
          ...provider,
        },
        signal,
      ),
    options.signal,
  );
  const pool = new Map<string, Entry>();
  let closed = false;
  const poolKey = (identity: Identity) =>
    JSON.stringify([identity.tenantId, identity.actorId]);
  const evict = async (key: string, entry: Entry) => {
    if (pool.get(key) === entry) pool.delete(key);
    clearTimeout(entry.timer);
    await entry.connection.then(
      (connection) => connection.close(),
      () => undefined,
    );
  };
  const schedule = (key: string, entry: Entry) => {
    clearTimeout(entry.timer);
    entry.usedAt = Date.now();
    entry.timer = setTimeout(() => {
      if (!entry.active) void evict(key, entry);
    }, idleMs);
    entry.timer.unref();
  };
  const isConnected = async (identity: Identity) =>
    !!(await store.load(oauthRecordKey(identity, serverUrl, redirectUrl)))
      ?.tokens;
  async function acquire(identity: Identity): Promise<[string, Entry]> {
    if (closed) throw new Error("MCP connection closed");
    const key = poolKey(identity);
    const existing = pool.get(key);
    if (existing) return [key, existing];
    if (!(await isConnected(identity))) throw notConnected();
    const raced = pool.get(key);
    if (raced) return [key, raced];
    if (pool.size >= maxConnections) {
      const [oldest] = [...pool]
        .filter(([, entry]) => !entry.active)
        .sort(([, a], [, b]) => a.usedAt - b.usedAt);
      if (oldest) void evict(...oldest);
    }
    const access = { identity, authorize: options.authorize, ...provider };
    const entry: Entry = {
      active: 0,
      usedAt: Date.now(),
      connection: reconnectingMcp(
        (signal) => connectMcp(actorConfig, access, signal, oauthFor(identity)),
        AbortSignal.timeout(catalog.timeoutMs ?? 30_000),
      ),
    };
    pool.set(key, entry);
    entry.connection.catch(() => {
      if (pool.get(key) === entry) pool.delete(key);
    });
    return [key, entry];
  }
  async function withActor<T>(
    identity: Identity,
    signal: AbortSignal,
    operation: (connection: McpConnection<Tool>) => Promise<T>,
  ): Promise<T> {
    const [key, entry] = await acquire(identity);
    entry.active++;
    try {
      return await operation(await abortable(() => entry.connection, signal));
    } catch (error) {
      if (
        error instanceof UnauthorizedError ||
        (error instanceof ToolCallError && error.code === "unauthorized")
      ) {
        void evict(key, entry);
        throw notConnected();
      }
      throw error;
    } finally {
      entry.active--;
      if (pool.get(key) === entry) schedule(key, entry);
    }
  }
  const wrap = (tool: Tool): Tool => {
    const name = catalog.toolNames?.get(tool.spec.name) ?? tool.spec.name;
    const isPublic = publicTools.includes(name);
    const authorize = (identity: Identity) => options.authorize(identity, name);
    async function route<R>(
      identity: Identity,
      signal: AbortSignal,
      operation: (target: Tool, as: Identity) => Promise<R>,
    ): Promise<R> {
      if (!(await abortable(() => authorize(identity), signal)))
        throw mcpAccessDenied();
      if (isPublic) return operation(tool, anonymous);
      return withActor(identity, signal, (connection) => {
        const found = connection.tools.find(
          (item) => item.spec.name === tool.spec.name,
        );
        if (
          found?.effect !== tool.effect ||
          (found.effect === "write" &&
            found.version !== (tool as WriteTool).version)
        )
          throw new Error("MCP tool changed");
        return operation(found, identity);
      });
    }
    if (tool.effect === "read")
      return {
        ...tool,
        authorize,
        execute: (args, identity, signal, run) =>
          route(identity, signal, (target, as) =>
            (target as ReadTool).execute(args, as, signal, run),
          ),
      };
    return {
      ...tool,
      authorize,
      prepare: (args, identity, signal) =>
        route(identity, signal, (target, as) =>
          (target as WriteTool).prepare(args, as, signal),
        ),
      execute: (args: unknown, context: ActionContext) =>
        route(context.identity, context.signal, (target, identity) =>
          (target as WriteTool).execute(args, { ...context, identity }),
        ),
      ...(tool.reconcile
        ? {
            reconcile: (id: string, identity: Identity, signal: AbortSignal) =>
              route(identity, signal, async (target, as) =>
                (target as WriteTool).reconcile?.(id, as, signal),
              ),
          }
        : {}),
    };
  };
  return {
    tools: catalog.tools.map(wrap),
    skipped: catalog.skipped,
    isConnected,
    async beginConnect(
      identity: Identity,
      signal: AbortSignal = AbortSignal.timeout(10_000),
    ): Promise<URL | undefined> {
      let target: URL | undefined;
      const oauth = oauthFor(identity, (url) => {
        target = url;
        return Promise.resolve();
      });
      await oauth.cancelPending();
      await oauth.coordinate(
        () =>
          auth(oauth.provider, {
            serverUrl,
            fetchFn: (input, init) =>
              fetch(input, { ...init, signal, redirect: "error" }),
          }),
        signal,
      );
      const redirect = target;
      const state = redirect?.searchParams.get("state");
      if (state)
        await store.update(stateKey(state), {
          pending: {
            state: JSON.stringify(identity),
            expiresAt: Date.now() + stateTtlMs,
          },
        });
      return redirect;
    },
    async completeConnect(
      params: URLSearchParams,
      signal: AbortSignal = AbortSignal.timeout(10_000),
    ): Promise<Identity> {
      const key = stateKey(params.get("state") ?? "");
      const pending = (await store.load(key))?.pending;
      if (!pending || pending.expiresAt <= Date.now())
        throw new Error("Invalid or expired OAuth state");
      if (!(await store.consumePending(key, pending.state)))
        throw new Error("Invalid or expired OAuth state");
      await store.remove?.(key);
      const identity = identitySchema.parse(JSON.parse(pending.state));
      await oauthFor(identity).complete(params, signal);
      const entry = pool.get(poolKey(identity));
      if (entry) await evict(poolKey(identity), entry);
      return identity;
    },
    async disconnect(identity: Identity, signal?: AbortSignal) {
      await oauthFor(identity).disconnect(signal);
      const entry = pool.get(poolKey(identity));
      if (entry) await evict(poolKey(identity), entry);
    },
    async close() {
      closed = true;
      await Promise.all([...pool].map(([key, entry]) => evict(key, entry)));
      await catalog.close();
    },
  };
}
export type McpActorPool = Awaited<ReturnType<typeof createMcpActorPool>>;
