import { z } from "zod";
import { randomBytes } from "node:crypto";
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
}
export type McpOAuth = Readonly<{
  provider: OAuthClientProvider;
  serverUrl: string;
  identity: Identity;
  complete: (params: URLSearchParams, signal?: AbortSignal) => Promise<void>;
  disconnect: () => Promise<void>;
}>;
export function createMcpOAuth(options: {
  serverUrl: string;
  redirectUrl: string;
  identity: Identity;
  store: McpOAuthStore;
  redirect: (url: URL) => Promise<void>;
}): McpOAuth {
  const server = new URL(options.serverUrl);
  const redirect = new URL(options.redirectUrl);
  for (const url of [server, redirect])
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error("Invalid OAuth URL");
  const identity = Object.freeze({ ...options.identity });
  const key = JSON.stringify([
    identity.tenantId,
    identity.actorId,
    server.href,
    redirect.href,
  ]);
  const load = async () => (await options.store.load(key)) ?? {};
  const update = (patch: Partial<OAuthSession>) =>
    options.store.update(key, patch);
  const provider: OAuthClientProvider = {
    redirectUrl: redirect.href,
    clientMetadata: {
      client_name: "Yada",
      redirect_uris: [redirect.href],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    clientInformation: async () => (await load()).client,
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
    state: async () => {
      const state = randomBytes(32).toString("base64url");
      await update({ pending: { state, expiresAt: Date.now() + 600_000 } });
      return state;
    },
    saveCodeVerifier: async (verifier) => {
      const pending = (await load()).pending;
      if (!pending) throw new Error("OAuth flow not started");
      await update({ pending: { ...pending, verifier } });
    },
    codeVerifier: async () => {
      const verifier = (await load()).pending?.verifier;
      if (!verifier) throw new Error("Missing OAuth verifier");
      return verifier;
    },
    redirectToAuthorization: options.redirect,
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
    serverUrl: server.href,
    identity,
    async complete(params, signal = AbortSignal.timeout(10_000)) {
      for (const name of ["state", "code", "error", "iss"])
        if (params.getAll(name).length > 1)
          throw new Error("Invalid OAuth callback");
      const state = params.get("state");
      if (!state) throw new Error("Missing OAuth state");
      const pending = await options.store.consumePending(key, state);
      if (!pending || pending.expiresAt <= Date.now() || !pending.verifier)
        throw new Error("Invalid or expired OAuth state");
      if (params.has("error")) throw new Error("OAuth authorization declined");
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
      if ((params.has("iss") || requiresIssuer) && params.get("iss") !== issuer)
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
            fetch(input, { ...init, signal, redirect: "error" }),
        });
        if (result !== "AUTHORIZED")
          throw new Error("OAuth authorization incomplete");
      } catch {
        throw new Error("OAuth token exchange failed");
      }
    },
    disconnect: () => update({ tokens: undefined, pending: undefined }),
  };
}
