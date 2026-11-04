---
layout: doc
title: "MCP OAuth"
description: "Integrate MCP OAuth authorization, callback validation and durable session storage with Yada while keeping connection credentials on the server."
---

# MCP OAuth

Yada supports browser-based authorization-code OAuth with PKCE and automatic token refresh for HTTP MCP connections. The host application supplies a callback route, browser redirect handler, authenticated identity, and durable token store.

## Connect and authorize

```ts
const oauth = createMcpOAuth({
  serverUrl: server.url,
  redirectUrl: "https://your-app.example/oauth/mcp/callback",
  identity,
  store: oauthStore,
  redirect: async (url) => sendBrowserRedirect(url.href),
});

const connection = await connectMcp(
  server,
  { identity, authorize },
  AbortSignal.timeout(10_000),
  oauth,
);
```

Servers that need a pre-registered client can pass `clientId` and, for confidential clients, `clientSecret` with `clientAuthMethod` (`"client_secret_basic"` by default, or `"client_secret_post"`). Pass `clientMetadataUrl` (HTTPS, with a path) to identify the client by a metadata document. Without these options Yada acts as a public client and registers dynamically. Keep the secret in server-side configuration.

Import `createMcpOAuth` and `connectMcp` from Yada. Do not combine OAuth with `token` or a stdio command. OAuth is bound to the exact server URL, actor, and tenant.

If authorization is needed, the SDK discovers the authorization server, registers the client where supported, generates PKCE parameters, and calls your `redirect` handler. The connection attempt then rejects with the SDK's `UnauthorizedError`; your route should treat that as pending login after a redirect, not as a successful connection. Handle other connection errors normally.

For servers requiring a pre-registered public client, call `oauth.provider.saveClientInformation` with its `client_id` and exact authorization-server `issuer` before connecting. The built-in metadata uses a public client with `token_endpoint_auth_method: none`.

## Callback

In your authenticated callback route, reconstruct the OAuth object with the same identity, URLs, and store, then:

```ts
await oauth.complete(new URL(request.url).searchParams);
const connection = await connectMcp(
  server,
  { identity, authorize },
  AbortSignal.timeout(10_000),
  oauth,
);
```

Pass the complete query, including `state`, `code`, and `iss` when returned. Yada rejects duplicate parameters, invalid or expired state, denial responses, and issuer mismatches. Pending state expires after ten minutes and is consumed once before token exchange. Exchange failures require starting a new authorization flow. Never reconstruct identity from callback query parameters.

The SDK refreshes stored credentials when the server rejects an expired token. If refresh cannot recover the session, another browser authorization may be required. Close old connections before reconnecting.

## Per-actor connections

`createMcpActorPool` serves one tool catalog to many signed-in actors, each through their own OAuth connection. Pass its `tools` to a worker profile.

```ts
const pool = await createMcpActorPool({
  config: {
    name: "crm",
    url,
    readTools: ["search", "get_account"],
    confirmTools: ["update_account"],
  },
  redirectUrl: "https://your-app.example/oauth/mcp/callback",
  store: storage.oauth,
  authorize: async (identity, tool) => canUse(identity, tool),
  publicTools: ["search"],
  idleMs: 300_000,
  maxConnections: 100,
});

const profile = { /* ... */ tools: pool.tools };

// A signed-in route: send the browser to the returned URL.
const url = await pool.beginConnect(identity);

// The public callback route needs no session: the actor comes from the state.
const actor = await pool.completeConnect(new URL(request.url).searchParams);
```

`client` takes the same `clientId`, `clientSecret`, `clientAuthMethod` and `clientMetadataUrl` as `createMcpOAuth`.

- **Catalog.** The pool discovers tools once, on a shared connection made with `config` as given, so the server must list tools anonymously or `config` must carry a service credential in `token` or `headers`. Otherwise creating the pool rejects with `UnauthorizedError`. Actor connections use neither `token` nor `headers`, only OAuth and any `actorHeaders` you pass.
- **Public tools.** Remote names in `publicTools` run on the shared connection, for any actor `authorize` allows, connected or not. The server sees no actor credentials on those calls and `_meta` names the actor `anonymous`.
- **Other tools.** They run on the actor's connection, opened on first use and reconnected as with `reconnectingMcp`. A connection idle for `idleMs` closes, and past `maxConnections` the least recently used idle one closes. A connection in use is never evicted, so connections can exceed `maxConnections` under load.
- **No connection.** A call from an actor with no tokens, or whose tokens the server rejects, throws `ToolCallError` with `code: "not_connected"`. The model receives `{"error":"account_not_connected","message":...}`. A write stops at preparation, before any approval, or at the recheck after approval. If the connection is lost during execution the action ends as `undelivered`. Tool calls never start a login, and rejected tokens are cleared, so `isConnected` turns false.
- **Connect flow.** `beginConnect(identity)` starts a new login, replacing any pending one, and returns the authorization URL, or `undefined` when stored credentials refresh without one. `completeConnect(params)` looks up the actor from a one-time record keyed by a hash of `state`, finishes the exchange and returns the identity. An unknown `state` is rejected without writing.
- **Bind the callback to the browser.** Without a binding, anyone holding an authorization URL can finish the flow: an attacker who sends their own URL to a victim gets the victim's account linked to the attacker's actor. Set a random value in a cookie on the sign-in route, pass it as `beginConnect(identity, signal, value)`, and pass the cookie's value as `completeConnect(params, signal, value)`. A mismatch is rejected before the state is used.
- **Other methods.** `isConnected(identity)` reads the store only. `disconnect(identity)` revokes and clears tokens. `close()` closes everything.

The one-time records expire after ten minutes and are removed on use; `storage.oauth.prune()` removes abandoned ones. `eraseActor` cannot find them, so an erased actor's identifiers can remain encrypted in such a record until it is pruned. A custom store without `remove` keeps used records as empty rows.

## Store contract

Implement `McpOAuthStore` in your server's storage layer:

- `load(key)` returns the session record or `undefined`.
- `update(key, patch)` atomically merges fields; explicit `undefined` deletes a field.
- `consumePending(key, state)` atomically compares state, removes the matching pending record, and returns it. A mismatch returns `undefined` without consuming another flow, and must not create a record.
- `remove(key)`, optional, deletes the record. `oauth.forget()` uses it.

Keys include tenant, actor, MCP endpoint, and callback URL. Preserve token, client-registration, and discovery objects unchanged, including their issuer stamps. Protect tokens and PKCE verifiers at rest. Do not log records or expose them to the browser. A pending login remains valid for ten minutes; another attempt fails with `OAuth login already pending` until that state is consumed, expired, or disconnected.

The optional `coordinate(key, operation, signal)` method receives a scoped store and cancellation signal. It must serialize the complete operation across application instances, renew ownership while the operation runs, and reject scoped reads, token saves, and state consumption after ownership expires or changes. The built-in durable store implements this with a renewable 30-second lease and atomic revision checks in the same encrypted session record. Late SDK callbacks cannot reacquire ownership and overwrite a newer session. Waiting and active operations are bounded by the caller's signal. Raw store writes during an active lease are rejected; use the scoped store inside `coordinate`.

Multi-process behavior is covered by tests that spawn separate processes against one Postgres or MySQL database (set `YADA_TEST_POSTGRES_URL` or `YADA_TEST_MYSQL_URL`; skipped otherwise): concurrent refreshes run one at a time without losing a token update, and a process suspended past lease expiry is fenced and cannot overwrite its replacement.

Existing custom stores remain compatible through a process-local queue shared by OAuth objects using the same store instance. Implement `coordinate` for deployments with multiple processes; the fallback cannot provide distributed fencing. Do not bypass `createMcpOAuth` provider callbacks with raw store writes during authentication.

Initialization and tool requests serialize the SDK's entire HTTP send/authentication lifecycle, including refresh and token persistence. Callback exchange and disconnect use the same coordination key. Unsolicited SSE authentication runs in an isolated coordinated lifecycle. MCP SDK 1.32.2 provides no public interception point for background SSE authentication, so a narrow adapter wraps its `_startOrAuthSse` hook. Missing hooks fail closed, and integration tests exercise background refresh; review this boundary when updating the pinned SDK. Resource streams retain their transport cancellation signal; the shorter coordination signal applies to OAuth discovery and token requests. SDK transport failures are redacted while authorization redirects preserve `UnauthorizedError`.

Use `storage.oauth` from [durable storage](storage.md), or implement this interface in your existing backend. Storage failures must propagate; do not silently fall back to memory. Callback checks depend on atomic consumption in your implementation.

`oauth.cancelPending()` clears an abandoned pending login so the user can retry immediately; tokens are kept.

`oauth.disconnect()` deletes local tokens and pending login state, then revokes the refresh and access tokens (RFC 7009) at the `revocation_endpoint` in the server's OAuth metadata, using the configured client authentication. Revocation is best effort: failures are ignored and local tokens are gone either way. A server that advertises no endpoint needs its own revocation flow. Close active MCP connections as well.

`oauth.forget()` does the same, then deletes the whole record, including client registration and discovery. `storage.oauth.eraseActor(identity)` deletes every record of an actor without revoking. `storage.oauth.prune()` deletes records holding no tokens, no client registration, no unexpired login and no live lease, and returns how many it removed; run it periodically if logins are often abandoned. `eraseActor` finds records by a scope written on each save, so it misses records last saved by Yada 0.3.0 or earlier: call `forget()` for those, or let them be rewritten first. A callback whose `state` does not match a pending login is rejected before anything is written, and `consumePending` never writes for an unknown state.

Use HTTPS endpoints and callbacks; HTTP is accepted only for loopback development. OAuth network redirects are refused. Protocol behavior follows the [MCP SDK OAuth provider contract](https://ts.sdk.modelcontextprotocol.io/client).
