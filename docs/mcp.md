---
layout: doc
title: "MCP connections"
---

# MCP connections

Connect an MCP server, then pass its tools to `run`. The connector supports Streamable HTTP and local stdio processes through the [MCP SDK](https://ts.sdk.modelcontextprotocol.io/client).

```ts
const connection = await connectMcp(
  {
    name: "catalog",
    url: "https://your-server.example/mcp",
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
| `readTools`       | Optional filter of tools your application has reviewed as read-only.                                                               |
| `writeTools`      | Explicit mapping of reviewed mutations to a version, preparation helper and receipt helper.                                        |
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

Use trusted server configuration for URLs and commands. The stdio transport launches and owns the process; closing the connection terminates it. Server stderr is suppressed. HTTP redirects are refused so credentials are not forwarded to another destination. For OAuth login and token refresh, see [MCP OAuth](mcp-oauth.md). Hosts can also supply a valid bearer token.

## Tool behavior

Remote tool names are prefixed: `lookup` becomes `catalog__lookup`. Use distinct connection names when combining tools from multiple servers. `run` rejects duplicate names.

Tool catalogs are discovered automatically. Without `readTools`, only tools advertising `readOnlyHint: true` are exposed as reads. With `readTools`, the host explicitly selects reviewed read tools, including tools without annotations. Tools explicitly marked as mutating are rejected from reads. Every tool still requires host authorization; annotations alone do not grant access. This does not sandbox or prevent side effects inside a remote server.

Discovery follows pagination with bounded page/tool counts and rejects duplicate tools, repeated cursors, or missing configured tools. Names must fit the provider-compatible 64-character limit after prefixing. Reconnect to refresh a changed tool catalog.

Inputs are validated against the advertised JSON Schema before transmission. Draft 7 and draft 2020-12 schemas are supported; external references are not fetched and asynchronous schema extensions are rejected. Requests and rendered results are bounded to 32,000 UTF-8 bytes. Structured read results become JSON text; text blocks are joined in order. Tool errors and unsupported media fail execution. Declared output schemas are validated against the discovered schema, including tools from earlier discovery pages.

Connection setup defaults to a ten-second deadline, which can be overridden with the third `connectMcp` argument. Discovery and calls have ten-second request timeouts and honor cancellation signals. Always close connections after use. External tool content remains untrusted data.

## Approved writes

Use writes only with a server whose implementation your application has reviewed against the Yada action compatibility contract below. This contract is specific to Yada; MCP annotations do not establish idempotency, receipt lookup, authorization or optimistic concurrency guarantees. Ordinary MCP servers that lack these guarantees cannot safely be enabled as write tools.

```ts
const connection = await connectMcp(
  {
    name: "catalog",
    url: "https://your-server.example/mcp",
    writeTools: {
      rename: {
        version: "reviewed-implementation-1",
        prepareTool: "prepare_rename",
        receiptTool: "rename_receipt",
      },
    },
  },
  { identity, authorize },
);
```

Pass these tools to the existing [durable worker and approval flow](actions.md). Each mapped mutation implements `WriteTool`; plain `run` without an action executor cannot execute it. Helpers remain hidden from the model. Mutation names, helper names and explicit `readTools` cannot overlap; helpers cannot be reused between mappings. Helpers must advertise `readOnlyHint: true`, and mutations cannot advertise that hint as true. These are consistency checks alongside the host's implementation review.

The permission callback receives original remote tool names. Preparation checks access to both the mutation and preparation helper; execution checks the mutation; reconciliation checks both the mutation and receipt helper. Every phase enforces the connection's actor and tenant, current authorization, cancellation and closure, including direct method calls.

The server contract uses these `tools/call` envelopes:

| Phase          | `arguments`                                   | Required `structuredContent`                                                           |
| -------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Preparation    | `{ "arguments": <original model arguments> }` | `{ "preview": <nonempty string>, "version": <state version> }`                         |
| Execution      | Original model arguments, unchanged           | `{ "status": "completed", "receipt": <nonempty string> }`                              |
| Receipt lookup | `{}`                                          | `{ "status": "completed", "receipt": <nonempty string> }` or `{ "status": "unknown" }` |

Every request adds top-level `params._meta["io.yada/action"]`:

```json
{
  "contractVersion": 1,
  "tool": "rename",
  "actorId": "authenticated actor",
  "tenantId": "authenticated tenant"
}
```

Execution also adds `operationId` and the approved state `version` from the durable action context. Receipt lookup adds only `operationId`; it must resolve that operation without issuing the mutation again. Model arguments cannot select or override this metadata. The preparation state version is a nonempty string of at most 1,024 characters; operation IDs are nonempty strings of at most 256 characters. Result envelopes are strict, size-bounded objects; text-only responses, empty receipts, additional fields or missing fields cannot establish successful execution.

The server must authenticate its actual connection credentials and validate the metadata's actor and tenant against that authenticated principal. Treating client metadata alone as authorization is insufficient. Preparation must be read-only. Execution must atomically enforce business authorization, the approved state version and operation-ID idempotency, scoped to the actor, tenant and mutation. Return the authoritative receipt for repeated operation IDs without performing another write. Receipt lookup must be read-only and return an authoritative result for that exact scope; missing, delayed or ambiguous outcomes stay unknown.

Transport failures, malformed responses, server errors and an execution response of `unknown` leave the durable action reconciling. Recovery calls only the receipt helper. It never resends an uncertain mutation, including after reconnect or process restart.

The adapter's `WriteTool.version` combines the reviewed version with a fingerprint of the target URL or stdio command/arguments, helper mapping and all three input/output schemas. Rotating bearer tokens are excluded. Changed policy prevents an old approval from crossing endpoints, mappings or schemas. `reconnectingMcp` also pins effect, version and specification, delegates all three write phases, reauthorizes each call and never replays a failed mutation.

Read-only literals retain `McpConnection<ReadTool>` through overloads. Configurations that might include `writeTools` return `McpConnection<Tool>`; narrow `tool.effect` before calling phase-specific methods. `McpReadConfig` expresses a configuration that cannot contain writes.

## Optional environment configuration

Leave `YADA_MCP_SERVERS` unset to use no MCP servers, or supply a JSON array:

```dotenv
YADA_MCP_SERVERS=[{"name":"catalog","url":"https://your-server.example/mcp"}]
```

`mcpServersFromEnv(process.env)` validates this array and returns server configurations for `connectMcp`. Each server has a unique name. Connect them with the appropriate identity and authorization callback, combine their `tools` arrays for `run`, and close all connections after use. OAuth stores and callback handlers are host code, not JSON settings. The environment loader does not launch processes or connect by itself.
