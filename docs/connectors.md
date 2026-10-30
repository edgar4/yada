---
layout: doc
title: "Read connectors"
---

# Read connectors

`httpReadTool` uses a Zod input schema, a fixed reviewed origin and path, and a trusted query parameter mapper. Only GET requests are issued. Redirects are refused; credentials and headers come from application configuration. Every execution checks authorization again, validates input, uses the caller's abort signal, and bounds streamed response bytes (32,000 by default; at most 1,000,000). Non-success responses and invalid UTF-8 fail without returning response content. Configure only trusted network destinations and headers.

`reviewedOpenApiGet(document, options)` checks a selected OpenAPI 3 GET operation against an explicit path and operation ID, then constructs the same HTTP tool. It accepts only declared query parameters. Path templates, referenced parameters, and other parameter locations require an application-owned adapter. The supplied Zod schema and mapper are the reviewed contract; this function does not automatically expose every operation or infer authorization from a document. Review server behavior before classifying any GET endpoint as read-only.

`createReadDatabase(config)` supports SQLite, PostgreSQL, and MySQL without running migrations or exposing a SQL tool. Its `tool` method accepts a fixed table, projected columns, tenant column, allowed equality filters, a Zod input schema, and a trusted values mapper. Identifiers are constrained and values are bound by Knex. Every SELECT includes the caller's tenant and a fixed row limit (100 by default; at most 1,000), checks authorization again, and rejects results above 32,000 bytes. SQL, identifiers, ordering, operators, and joins cannot come from model arguments. Use database credentials restricted to SELECT as an additional boundary. Cancellation stops waiting; driver queries can continue until their 10-second timeout. Call `close` during shutdown.

`reconnectingMcp(signal => connectMcp(config, access, signal))` retains the original tool interface. After a transport closes, concurrent callers share one new connection and discovery pass. Reconnection has a 10-second deadline and requires identical tool names, descriptions, and input schemas, ignoring object-key order. Changed discovery closes the replacement and fails the call. Every execution checks current authorization; failures from an in-flight tool call are surfaced without replay. Call again after transport failure to reconnect. Revocation and tenant checks remain owned by `connectMcp`. Closing the wrapper prevents future calls and disposes any connection created during an outstanding reconnect. Authentication refresh remains the responsibility of the configured MCP OAuth provider.

Run optional real PostgreSQL/MySQL read tests with `YADA_TEST_POSTGRES_URL` and `YADA_TEST_MYSQL_URL` connection URLs. These tests create uniquely named tables and remove them afterward; they do not run Yada storage migrations.
