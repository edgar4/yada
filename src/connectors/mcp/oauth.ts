import { z } from "zod";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { abortable } from "../../core/abort.js";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Identity } from "../../core/contracts.js";
export type OAuthPending = Readonly<{
  state: string;
  expiresAt: number;
  verifier?: string;
}>;
export type OAuthSession = {
  client?: OAuthClientInformationMixed | undefined;
  tokens?: OAuthTokens | undefined;
  discovery?: OAuthDiscoveryState | undefined;
  pending?: OAuthPending | undefined;
};
export interface McpOAuthStore {
  load(key: string): Promise<OAuthSession | undefined>;
  update(key: string, patch: Partial<OAuthSession>): Promise<void>;
  consumePending(key: string, state: string): Promise<OAuthPending | undefined>;
  remove?(key: string): Promise<void>;
  coordinate?<T>(
    key: string,
    operation: (store: McpOAuthStore, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
export type McpOAuth = Readonly<{
  provider: OAuthClientProvider;
  serverUrl: string;
  identity: Identity;
  complete: (params: URLSearchParams, signal?: AbortSignal) => Promise<void>;
  disconnect: (signal?: AbortSignal) => Promise<void>;
  cancelPending: () => Promise<void>;
  coordinate?: <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
    isolated?: boolean,
  ) => Promise<T>;
  signal?: () => AbortSignal | undefined;
}>;
const allowedEndpoint = (url: URL) =>
  (url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
  !url.username &&
  !url.password &&
  !url.hash;
const localQueues = new WeakMap<McpOAuthStore, Map<string, Promise<void>>>();
export function createMcpOAuth(options: {
  serverUrl: string;
  redirectUrl: string;
  identity: Identity;
  store: McpOAuthStore;
  redirect: (url: URL) => Promise<void>;
  clientId?: string;
  clientSecret?: string;
  clientAuthMethod?: "client_secret_basic" | "client_secret_post";
  clientMetadataUrl?: string;
}): McpOAuth & { forget: (signal?: AbortSignal) => Promise<void> } {
  if (options.clientSecret && !options.clientId)
    throw new Error("OAuth clientSecret requires clientId");
  if (options.clientMetadataUrl) {
    const metadata = new URL(options.clientMetadataUrl);
    if (metadata.protocol !== "https:" || metadata.pathname === "/")
      throw new Error("Invalid OAuth client metadata URL");
  }
  const server = new URL(options.serverUrl);
  const redirect = new URL(options.redirectUrl);
  for (const url of [server, redirect])
    if (!allowedEndpoint(url) || url.search)
      throw new Error("Invalid OAuth URL");
  const identity = Object.freeze({ ...options.identity });
  const key = JSON.stringify([
    identity.tenantId,
    identity.actorId,
    server.href,
    redirect.href,
  ]);
  const context = new AsyncLocalStorage<{
    store: McpOAuthStore;
    signal: AbortSignal;
    active: boolean;
  }>();
  async function coordinate<T>(
    operation: () => Promise<T>,
    signal = AbortSignal.timeout(10_000),
    isolated = false,
  ): Promise<T> {
    const current = context.getStore();
    if (current && !isolated) {
      if (!current.active || current.signal.aborted)
        throw new Error("OAuth coordination lost");
      return operation();
    }
    const run = (store: McpOAuthStore, activeSignal: AbortSignal) => {
      const scope = { store, signal: activeSignal, active: true };
      return context.run(scope, async () => {
        try {
          return await operation();
        } finally {
          scope.active = false;
        }
      });
    };
    if (options.store.coordinate)
      return options.store.coordinate(key, run, signal);
    const queue =
      localQueues.get(options.store) ?? new Map<string, Promise<void>>();
    localQueues.set(options.store, queue);
    const previous = queue.get(key) ?? Promise.resolve();
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = previous.then(() => waiting);
    queue.set(key, pending);
    try {
      await abortable(() => previous, signal);
      return await abortable(() => run(options.store, signal), signal);
    } finally {
      release();
      void pending.then(() => {
        if (queue.get(key) === pending) queue.delete(key);
      });
    }
  }
  const store = () => {
    const scope = context.getStore();
    if (!scope?.active || scope.signal.aborted)
      throw new Error("OAuth coordination lost");
    return scope.store;
  };
  const load = () => coordinate(async () => (await store().load(key)) ?? {});
  const update = (patch: Partial<OAuthSession>) =>
    coordinate(() => store().update(key, patch));
  const disconnect = async (signal = AbortSignal.timeout(10_000)) => {
    const session = await coordinate(async () => {
      const current = await load();
      await update({ tokens: undefined, pending: undefined });
      return current;
    }, signal);
    const { revocation_endpoint: endpoint } = z
      .object({ revocation_endpoint: z.url().optional() })
      .catch({})
      .parse(session.discovery?.authorizationServerMetadata ?? {});
    if (!endpoint || !allowedEndpoint(new URL(endpoint))) return;
    const clientId = options.clientId ?? session.client?.client_id;
    const secret =
      options.clientSecret ??
      (session.client as { client_secret?: string } | undefined)?.client_secret;
    const post = options.clientAuthMethod === "client_secret_post";
    for (const [hint, token] of [
      ["refresh_token", session.tokens?.refresh_token],
      ["access_token", session.tokens?.access_token],
    ])
      if (token)
        await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal,
          headers:
            secret && clientId && !post
              ? {
                  authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`,
                }
              : {},
          body: new URLSearchParams({
            token,
            token_type_hint: hint ?? "",
            ...(clientId && (!secret || post) ? { client_id: clientId } : {}),
            ...(secret && post ? { client_secret: secret } : {}),
          }),
        }).catch(() => undefined);
  };
  const provider: OAuthClientProvider = {
    redirectUrl: redirect.href,
    clientMetadata: {
      client_name: "Yada",
      redirect_uris: [redirect.href],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: options.clientSecret
        ? (options.clientAuthMethod ?? "client_secret_basic")
        : "none",
    },
    ...(options.clientMetadataUrl
      ? { clientMetadataUrl: options.clientMetadataUrl }
      : {}),
    clientInformation: async () =>
      options.clientId
        ? {
            client_id: options.clientId,
            ...(options.clientSecret
              ? { client_secret: options.clientSecret }
              : {}),
          }
        : (await load()).client,
    saveClientInformation: (client) => update({ client }),
    tokens: async () => (await load()).tokens,
    saveTokens: (tokens) => update({ tokens }),
    discoveryState: async () => (await load()).discovery,
    saveDiscoveryState: (discovery) => {
      if (
        discovery.authorizationServerMetadata?.issuer &&
        discovery.authorizationServerMetadata.issuer !==
          discovery.authorizationServerUrl
      )
        throw new Error("OAuth discovery issuer mismatch");
      return update({ discovery });
    },
    state: () =>
      coordinate(async () => {
        const pending = (await load()).pending;
        if (pending && pending.expiresAt > Date.now())
          throw new Error("OAuth login already pending");
        const state = randomBytes(32).toString("base64url");
        await update({ pending: { state, expiresAt: Date.now() + 600_000 } });
        return state;
      }),
    saveCodeVerifier: (verifier) =>
      coordinate(async () => {
        const pending = (await load()).pending;
        if (!pending || pending.expiresAt <= Date.now())
          throw new Error("OAuth flow not started");
        await update({ pending: { ...pending, verifier } });
      }),
    codeVerifier: async () => {
      const verifier = (await load()).pending?.verifier;
      if (!verifier) throw new Error("Missing OAuth verifier");
      return verifier;
    },
    redirectToAuthorization: (url) => coordinate(() => options.redirect(url)),
    invalidateCredentials: async (scope) => {
      if (scope === "all")
        await update({
          client: undefined,
          tokens: undefined,
          discovery: undefined,
          pending: undefined,
        });
      else if (scope === "client") await update({ client: undefined });
      else if (scope === "tokens") await update({ tokens: undefined });
      else if (scope === "discovery") await update({ discovery: undefined });
      else await update({ pending: undefined });
    },
  };
  return {
    provider,
    coordinate,
    signal: () => context.getStore()?.signal,
    serverUrl: server.href,
    identity,
    async complete(params, signal = AbortSignal.timeout(10_000)) {
      for (const name of ["state", "code", "error", "iss"])
        if (params.getAll(name).length > 1)
          throw new Error("Invalid OAuth callback");
      const state = params.get("state");
      if (!state) throw new Error("Missing OAuth state");
      if ((await options.store.load(key))?.pending?.state !== state)
        throw new Error("Invalid or expired OAuth state");
      return coordinate(async () => {
        const pending = await store().consumePending(key, state);
        if (!pending || pending.expiresAt <= Date.now() || !pending.verifier)
          throw new Error("Invalid or expired OAuth state");
        if (params.has("error"))
          throw new Error("OAuth authorization declined");
        const code = params.get("code");
        if (!code) throw new Error("Missing OAuth code");
        const discovery = (await load()).discovery;
        const issuer =
          discovery?.authorizationServerMetadata?.issuer ??
          discovery?.authorizationServerUrl;
        if (!issuer) throw new Error("Missing OAuth discovery");
        const requiresIssuer =
          z
            .object({
              authorization_response_iss_parameter_supported: z
                .boolean()
                .optional(),
            })
            .parse(discovery?.authorizationServerMetadata ?? {})
            .authorization_response_iss_parameter_supported === true;
        if (
          (params.has("iss") || requiresIssuer) &&
          params.get("iss") !== issuer
        )
          throw new Error("OAuth issuer mismatch");
        const callbackProvider = {
          ...provider,
          codeVerifier: () => pending.verifier ?? "",
        };
        try {
          const result = await auth(callbackProvider, {
            serverUrl: server,
            authorizationCode: code,
            fetchFn: (input, init) =>
              fetch(input, {
                ...init,
                signal: context.getStore()?.signal ?? signal,
                redirect: "error",
              }),
          });
          if (result !== "AUTHORIZED")
            throw new Error("OAuth authorization incomplete");
        } catch {
          throw new Error("OAuth token exchange failed");
        }
      }, signal);
    },
    disconnect,
    async forget(signal) {
      await disconnect(signal);
      await options.store.remove?.(key);
    },
    cancelPending: () => update({ pending: undefined }),
  };
}
