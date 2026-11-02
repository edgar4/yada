---
layout: doc
title: "Read connectors"
description: "Connect Yada to reviewed HTTP APIs and tenant-scoped business database reads using typed inputs, authorization checks and bounded results."
---

# Read connectors

`httpReadTool` uses a Zod input schema, a fixed reviewed origin and path, and a trusted query parameter mapper. Only GET requests are issued. Redirects are refused; credentials and headers come from application configuration. Every execution checks authorization again, validates input, uses the caller's abort signal, and bounds streamed response bytes (32,000 by default; at most 1,000,000). Non-success responses and invalid UTF-8 fail without returning response content. Configure only trusted network destinations and headers.

```ts
const lookupOrder = httpReadTool({
  name: "lookup_order",
  description: "Look up an order",
  input: z.strictObject({ id: z.string(), expand: z.string().optional() }),
  origin: "https://api.example.com",
  path: "/orders/{id}",
  pathParameters: (args) => ({ id: args.id }),
  parameters: (args) => ({ expand: args.expand }),
  headers: async (identity) => ({
    authorization: `Bearer ${await tokenFor(identity)}`,
  }),
  authorize: async (identity) => canRead(identity),
});
```

`path` may contain `{name}` placeholders. `pathParameters` must return exactly those names; values are URL-encoded and empty, `.` and `..` values are refused. `headers` is an object or a sync/async function of the caller's identity.

`reviewedOpenApiGet(document, options)` checks a selected OpenAPI 3 GET operation against an explicit path and operation ID, then constructs the same HTTP tool. It accepts only declared query parameters, and path templates whose `{name}` placeholders match the operation's declared `in: path` parameters. Referenced parameters and other parameter locations require an application-owned adapter. The supplied Zod schema and mapper are the reviewed contract; this function does not automatically expose every operation or infer authorization from a document. Review server behavior before classifying any GET endpoint as read-only.

```ts
const openapi = reviewedOpenApiGet(document, {
  ...options,
  path: "/orders/{id}",
  operationId: "getOrder",
  pathParameters: (args) => ({ id: args.id }),
});
```

`createReadDatabase(config)` supports SQLite, PostgreSQL, and MySQL without running migrations or exposing a SQL tool. Its `tool` method accepts a fixed table, projected columns, tenant column, allowed equality filters, a Zod input schema, and a trusted values mapper. Identifiers are constrained and values are bound by Knex. Every SELECT includes the caller's tenant and a fixed row limit (100 by default; at most 1,000), checks authorization again, and rejects results above 32,000 bytes. SQL, identifiers, ordering, operators, and joins cannot come from model arguments. Use database credentials restricted to SELECT as an additional boundary. Cancellation stops waiting; driver queries can continue until their 10-second timeout. Call `close` during shutdown.

```ts
const database = createReadDatabase({ driver: "sqlite", filename: "app.db" });
const listOrders = database.tool({
  name: "list_orders",
  description: "List the caller's orders",
  input: z.strictObject({ status: z.string() }),
  table: "orders",
  columns: ["id", "status", "total"],
  tenantColumn: "tenant_id",
  filters: { status: "status" },
  values: (args) => ({ status: args.status }),
  authorize: async (identity) => canRead(identity),
});
```

`reconnectingMcp(signal => connectMcp(config, access, signal))` retains the original tool interface. After a transport closes, concurrent callers share one new connection and discovery pass. Reconnection uses the connection's configured `timeoutMs` as its deadline (10 seconds when the connection does not report one) and requires identical tool names, descriptions, and input schemas, ignoring object-key order. Changed discovery closes the replacement and fails the call. Every execution checks current authorization; failures from an in-flight tool call are surfaced without replay. Call again after transport failure to reconnect. Revocation and tenant checks remain owned by `connectMcp`. Closing the wrapper prevents future calls and disposes any connection created during an outstanding reconnect. Authentication refresh remains the responsibility of the configured MCP OAuth provider.

Run optional real PostgreSQL/MySQL read tests with `YADA_TEST_POSTGRES_URL` and `YADA_TEST_MYSQL_URL` connection URLs. These tests create uniquely named tables and remove them afterward; they do not run Yada storage migrations.
