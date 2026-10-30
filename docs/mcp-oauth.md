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

## Store contract

Implement `McpOAuthStore` in your server's storage layer:

- `load(key)` returns the session record or `undefined`.
- `update(key, patch)` atomically merges fields; explicit `undefined` deletes a field.
- `consumePending(key, state)` atomically compares state, removes the matching pending record, and returns it. A mismatch returns `undefined` without consuming another flow.

Keys include tenant, actor, MCP endpoint, and callback URL. Preserve token, client-registration, and discovery objects unchanged, including their issuer stamps. Protect tokens and PKCE verifiers at rest. Do not log records or expose them to the browser. A pending login remains valid for ten minutes; another attempt fails with `OAuth login already pending` until that state is consumed, expired, or disconnected.

The optional `coordinate(key, operation, signal)` method receives a scoped store and cancellation signal. It must serialize the complete operation across application instances, renew ownership while the operation runs, and reject scoped reads, token saves, and state consumption after ownership expires or changes. The built-in durable store implements this with a renewable 30-second lease and atomic revision checks in the same encrypted session record. Late SDK callbacks cannot reacquire ownership and overwrite a newer session. Waiting and active operations are bounded by the caller's signal. Raw store writes during an active lease are rejected; use the scoped store inside `coordinate`.

Existing custom stores remain compatible through a process-local queue shared by OAuth objects using the same store instance. Implement `coordinate` for deployments with multiple processes; the fallback cannot provide distributed fencing. Do not bypass `createMcpOAuth` provider callbacks with raw store writes during authentication.

Initialization and tool requests serialize the SDK's entire HTTP send/authentication lifecycle, including refresh and token persistence. Callback exchange and disconnect use the same coordination key. Unsolicited SSE authentication runs in an isolated coordinated lifecycle. MCP SDK 1.32.2 provides no public interception point for background SSE authentication, so a narrow adapter wraps its `_startOrAuthSse` hook. Missing hooks fail closed, and integration tests exercise background refresh; review this boundary when updating the pinned SDK. Resource streams retain their transport cancellation signal; the shorter coordination signal applies to OAuth discovery and token requests. SDK transport failures are redacted while authorization redirects preserve `UnauthorizedError`.

Use `storage.oauth` from [durable storage](storage.md), or implement this interface in your existing backend. Storage failures must propagate; do not silently fall back to memory. Callback checks depend on atomic consumption in your implementation.

`oauth.disconnect()` deletes local tokens and pending login state. Close active MCP connections as well. This does not revoke the upstream authorization grant; use the provider's account controls when revocation is required.

Use HTTPS endpoints and callbacks; HTTP is accepted only for loopback development. OAuth network redirects are refused. Protocol behavior follows the [MCP SDK OAuth provider contract](https://ts.sdk.modelcontextprotocol.io/client).
