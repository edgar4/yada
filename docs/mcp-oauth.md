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

Keys include tenant, actor, MCP endpoint, and callback URL. Preserve token, client-registration, and discovery objects unchanged, including their issuer stamps. Protect tokens and PKCE verifiers at rest. Do not log records or expose them to the browser. Serialize login/refresh operations for each key across application instances; starting another flow replaces the pending state.

Yada supplies this interface rather than an in-memory production token store. Storage failures must propagate; do not silently fall back to memory. Callback checks depend on atomic consumption in your implementation.

`oauth.disconnect()` deletes local tokens and pending login state. Close active MCP connections as well. This does not revoke the upstream authorization grant; use the provider's account controls when revocation is required.

Use HTTPS endpoints and callbacks; HTTP is accepted only for loopback development. OAuth network redirects are refused. Protocol behavior follows the [MCP SDK OAuth provider contract](https://ts.sdk.modelcontextprotocol.io/client).
