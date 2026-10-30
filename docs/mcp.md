# MCP connections

Connect an MCP server, then pass its tools to `run`. The connector supports Streamable HTTP and local stdio processes through the [MCP SDK](https://ts.sdk.modelcontextprotocol.io/client).

```ts
const connection = await connectMcp(
  {
    name: "catalog",
    url: "https://your-server.example/mcp",
    readTools: ["lookup"],
  },
  {
    identity,
    authorize: async (actor, tool) => permissions.canRead(actor, tool),
  },
);

try {
  const result = await run({
    provider,
    tools: connection.tools,
    identity,
    input: "Find product A",
    system: "Use the catalog to answer product questions.",
    signal: AbortSignal.timeout(30_000),
  });
} finally {
  await connection.close();
}
```

Import `connectMcp` and `run` from Yada's public entry point. `identity` must come from your authenticated backend. The permission callback is application code; discovery and execution both check access. Each connection is bound to its original actor and tenant.

## Configuration

| Field             | Purpose                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Unique server namespace, such as `catalog`. Lowercase letters, digits, and underscores; starts with a letter, up to 20 characters. |
| `url`             | Remote MCP endpoint.                                                                                                               |
| `token`           | Optional bearer token issued for the MCP server, separate from your model API key.                                                 |
| `readTools`       | Explicit names of tools your application has reviewed as read-only.                                                                |
| `command`, `args` | Local server executable and arguments, instead of `url` and `token`.                                                               |

For a local server:

```ts
const server = {
  name: "catalog",
  command: "node",
  args: ["/absolute/path/to/catalog-server.js"],
  readTools: ["lookup"],
};
```

Use trusted server configuration for URLs and commands. The stdio transport launches and owns the process; closing the connection terminates it. Server stderr is suppressed. HTTP redirects are refused so credentials are not forwarded to another destination. OAuth login and refresh flows are not implemented; hosts may supply a valid bearer token.

## Tool behavior

Remote tool names are prefixed: `lookup` becomes `catalog__lookup`. Use distinct connection names when combining tools from multiple servers. `run` rejects duplicate names.

Only explicitly allowed read tools are exposed. Server annotations do not grant permission; tools explicitly marked as mutating are rejected. Listing a tool in `readTools` is the host's assertion that it is safe to read. This does not sandbox or prevent side effects inside a remote server. Write tools require a separate approval workflow and are not supported by this connector.

Discovery follows pagination with bounded page/tool counts and rejects duplicate tools, repeated cursors, or missing configured tools. Names must fit the provider-compatible 64-character limit after prefixing. Reconnect to refresh a changed tool catalog.

Inputs are validated against the advertised JSON Schema before transmission. Draft 7 and draft 2020-12 schemas are supported; external references are not fetched. Structured results become JSON text; text blocks are joined in order. Tool errors, unsupported media, and results above 32,000 characters fail execution. The SDK also validates declared output schemas.

Connection setup defaults to a ten-second deadline, which can be overridden with the third `connectMcp` argument. Discovery and calls have ten-second request timeouts and honor cancellation signals. Always close connections after use. External tool content remains untrusted data.
