---
layout: doc
title: "Durable service"
description: "Compose Yada’s authenticated HTTP service and worker for durable conversations, scheduled runs, replayable events, cancellation and action decisions."
---

# Durable service

Compose the server with your application's authentication and authorization:

```ts
const storage = await createStorage(storageConfigFromEnv(process.env));
const profiles = {
  "support-v1": {
    provider: createProvider(providerConfigFromEnv(process.env)),
    tools,
    system: "Help the user.",
  },
};
const worker = createWorker({ storage, profiles });
const handler = createHandler({
  storage,
  origins: ["https://your-website.example"],
  authenticate: authenticateYourSession,
  authorizeProfile: authorizeYourProfile,
});
const server = createNodeServer(handler);
worker.start();
server.listen(3000, "127.0.0.1");
```

Import the functions from Yada's public entry point. Authentication must return the verified `{ tenantId, actorId }`, never values copied from the request body. Profile authorization decides which configured agent the actor can use. Use explicit allowed browser origins and host-managed sessions or bearer credentials. Provider credentials remain on the server.

Optional `quota` limits run submissions and spend per tenant or actor; see [Operations](operations.md#tenant-quotas). Pass the same `quota` to `createHandler` and `createWorker`.

On shutdown, stop accepting new requests, await `worker.stop()`, then close storage. Shutdown leaves active runs recoverable; user cancellation is a separate operation. Start one migration opener before scaling workers. SQLite uses one persistent local volume; PostgreSQL and MySQL support workers on multiple hosts with synchronized clocks.

## HTTP API

All paths start with `/v1/conversations/{conversationId}/runs`. IDs are scoped to the authenticated tenant and actor.

| Method | Suffix                                  | Behavior                                                                                                                                                                                                                                |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/`                                     | Submit `{ id, profileId, input }`; `input` is text or parts (up to 4 images, 5 MB each, text up to 32,000 characters; body cap `maxJobBodyBytes`, about 28 MB); returns 202 after durable commit                                        |
| GET    | `/{id}`                                 | Inspect the run                                                                                                                                                                                                                         |
| GET    | `/{id}/events?after=0`                  | Stream versioned NDJSON events; replay from sequence cursor                                                                                                                                                                             |
| POST   | `/{id}/cancel`                          | Persist a cancellation request                                                                                                                                                                                                          |
| POST   | `/{id}/messages`                        | Steer a running run with `{ id, input }` (same content rules as submission); idempotent by `id`; returns 202. Returns 409 for a finished run, a reused `id` with different input, or more than 8 messages in one run                    |
| GET    | `/{id}/approvals/{approvalId}`          | Read preview, status and expiry                                                                                                                                                                                                         |
| POST   | `/{id}/approvals/{approvalId}/decision` | Submit `{ approved, remember? }`; `remember` is `"run"` or `"conversation"`. Returns 409 unless the run is awaiting that approval or when the opposite decision was already recorded; repeating an already applied decision returns 202 |

Steering messages are stored on the run and delivered as user turns at the start of the next model round, after pending tool calls finish. A message sent while the run is `awaiting_approval` waits and is delivered after the decision; it does not resume the run. The worker marks a message consumed only after the checkpoint holding it is saved, and a redelivered message already in the checkpoint is skipped, so a crash never duplicates or loses it. A message that arrives during the final model call is delivered as another round, unless the run has used its last round.

Generate a unique run ID before submission and reuse it when retrying that submission. An identical resend returns 202 with the existing run; reusing the ID with changed input or profile returns 409. A conversation accepts one unfinished run at a time. Completed answers and conversation history are committed atomically, so recovery cannot append an answer twice. Network disconnection never cancels the run.

Events have `version`, `sequence`, `type`, and `at`, with optional `text`, `code`, `approvalId`, or (on `awaiting_approval`) `expiresAt`. Streams provide lifecycle progress, tool activity and complete answers; they do not expose provider reasoning. Persisted `tool_started` (read tools only, since writes already report approval and reconciliation), `tool_finished` (with `failed`) and `usage` (`inputTokens`, `outputTokens`) events carry the tool name or token counts only, never arguments or content, and do not change the run status. Reconnect using the last processed sequence and discard already processed events. Errors are sanitized and responses are not cacheable.

Quota is consumed only when a submission creates a new run; resends and 409 conflicts are free. All other routes share a per-actor limit of 600 requests per minute, and each actor may hold 8 concurrent event streams; override with `limits: { requestsPerMinute, streamsPerActor }`. These counters are per process. `Retry-After` is exposed to browsers through CORS.

## Conversations

| Method | Path                            | Behavior                                                                                                                                                |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/conversations?after&limit` | The caller's own conversations as `{ conversations: [{ id, updatedAt, status? }], next? }`. Pass `next` as `after`; `limit` is 1 to 100 (default 50)    |
| GET    | `/v1/conversations/{id}`        | `{ id, messages }` with user and assistant text and `{ role: "failure", code }` entries; summaries and tool turns are omitted. 404 if unknown or erased |
| DELETE | `/v1/conversations/{id}`        | Erase via `eraseConversation`, including remembered approvals; 204. 409 while a run is unfinished                                                       |

Listing scans stored conversations, so it suits modest volumes per deployment.

## Health, errors and webhooks

`GET /healthz` returns 200 and `GET /readyz` checks storage (503 when unavailable); both are served without authentication. Pass `onError(error, request)` to `createHandler` and `createNodeServer` to log unexpected failures (clients still receive a sanitized 503). `createNodeServer(handler, options)` sets `requestTimeoutMs` (30 s), `headersTimeoutMs` (15 s) and `keepAliveTimeoutMs` (65 s) and accepts `maxConnections`. `closeNodeServer(server, graceMs = 10000)` stops accepting connections, closes idle ones, lets in-flight requests finish, then closes the rest after the grace period.

Pass `webhooks: { url, secret }` (secret at least 16 characters) to `createWorker` to receive `POST` JSON `{ type, conversationId, runId, status }` on `completed`, `failed`, `cancelled` and `awaiting_approval`. The `x-yada-signature` header is `sha256=` plus the hex HMAC-SHA256 of the raw body. Delivery is best effort and at least once: three attempts with backoff, a 5 s timeout, no redirects, never blocking the worker. Fetch run details through the API.

If a crash occurs between recording an approval decision and resuming the run, `GET /{id}` or the event stream resumes it.

## Live text

Pass the same `createEventBus()` to `createWorker({ bus })` and `createHandler({ bus })` in one process to stream model text. The worker publishes `text_delta` events (`text`) to the bus; they are never persisted. The event stream merges them with persisted events: a delta's `sequence` is the latest persisted sequence when it was produced, so clients show it after that event, and it does not advance the replay cursor. Deltas are not replayed after a reconnect; the final answer arrives in the `completed` event, and clients should replace streamed text with it. Without a shared bus (separate processes, or no `bus`), runs use `complete` and streams contain persisted events only. With a bus the handler polls storage every 500 ms (100 ms without) and wakes early on live text. Streams re-authenticate at most every 5 seconds.

`BrowserClient.events()` yields `text_delta` events alongside persisted ones, and the widget renders streamed text in a live bubble and shows `Running {tool}` while tools execute.

`createWorker` discovers queued and interrupted jobs from encrypted storage. Missing profile versions remain queued until that configuration is restored. Profiles must stay stable for unfinished jobs. Lease conflicts defer execution to the owning worker and never count as attempts. `concurrency` (default 4) bounds simultaneous jobs across ticks: each tick starts new jobs only while slots are free and does not wait for running jobs, though `tick()` resolves once the jobs it started finish; `stop()` drains all in-flight jobs. A run that throws a retryable error (for example a storage failure) is retried with exponential backoff (2 s doubling to 60 s, jittered); after `maxAttempts` (default 5) it fails with `retry_exhausted`. A run exceeding the profile `timeoutMs` (default 300,000) fails with `timeout`; user cancellation ends as `cancelled`, and shutdown leaves the job recoverable. `tick()` supports externally scheduled workers; `start()` polls automatically. `trace` receives only event name, status, duration, attempt number and failure code, without prompts, identity, credentials, or tool arguments.

## Client contract

For clients in other languages (a Python package belongs in its own repository). Every request carries the host's credentials (`Authorization` header or session cookie). Base path: `/v1/conversations/{conversationId}/runs`.

| Call                                         | Request body                                                         | Success                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /`                                     | `{ "id", "profileId", "input" }`, JSON, run ID unique per submission | 202 with the stored run                                                                |
| `GET /{id}`                                  | none                                                                 | 200 run with `status`, `outcome`, `events`, `history` (`{ role, content }` text turns) |
| `GET /{id}/events?after={n}`                 | none                                                                 | 200 `application/x-ndjson`, one event per line, closes after a terminal event          |
| `POST /{id}/cancel`                          | none                                                                 | 202 `{ "accepted": true }`                                                             |
| `POST /{id}/messages`                        | `{ "id", "input" }`, message ID unique per message, resend on error  | 202 `{ "accepted": true }`; 409 once the run is finished or has 8 messages             |
| `GET /{id}/approvals/{approvalId}`           | none                                                                 | 200 `{ id, preview, status, expiresAt }`                                               |
| `POST /{id}/approvals/{approvalId}/decision` | `{ "approved": bool, "remember"?: "run" or "conversation" }`         | 202 `{ "accepted": true }`                                                             |

Errors are `{ "error": string }` with these statuses:

| Status | Meaning                                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Invalid request body, missing body or invalid parameters                                                                                                                                       |
| 401    | Authentication required; renew credentials, then retry                                                                                                                                         |
| 403    | Origin or profile denied; do not retry                                                                                                                                                         |
| 404    | Unknown path, run or approval; also the response for runs of another tenant or actor                                                                                                           |
| 409    | Conflict: run ID reused with different input, unfinished run in the conversation, approval not pending, or `after` beyond the stored events                                                    |
| 410    | Conversation was erased                                                                                                                                                                        |
| 413    | Request body too large                                                                                                                                                                         |
| 429    | Tenant or actor quota exceeded on run submission, per-actor request limit, or too many concurrent event streams (`{ "error": "Rate limit exceeded" }`). Wait `Retry-After` seconds, then retry |
| 415    | JSON endpoints require `Content-Type: application/json`                                                                                                                                        |
| 503    | Temporary or unexpected failure; retry with backoff                                                                                                                                            |

Event lines are JSON objects `{ version: 1, sequence, type, at }` plus optional `text`, `code`, `approvalId`, `expiresAt`, `tool`, `failed`, `inputTokens`, `outputTokens`. Types: `queued`, `running`, `progress`, `awaiting_approval`, `reconciling`, `completed`, `failed`, `cancelled`, `tool_started`, `tool_finished`, `usage`, `steering_received` and, only on a shared event bus, `text_delta`. Terminal types are `completed` (`text`), `failed` (`code`) and `cancelled`. `tests/fixtures/service-events.ndjson` holds a sample stream that the test suite validates against the event schema.

Submit and follow a run:

1. Generate a run ID and `POST /` with it. After a network error or 5xx, resend the identical body; an identical resend returns 202 with the existing run, so continue to step 2. A 409 means a different request reused the ID or another run is active.
2. Set `cursor = 0`. Open `GET /{id}/events?after={cursor}`.
3. For each line, skip `text_delta` events (they have no persisted sequence) and any event with `sequence <= cursor`; handle the rest and set `cursor = sequence`.
4. On `awaiting_approval`, read the approval, show `preview`, and `POST` the decision before `expiresAt`. The stream keeps running afterwards.
5. Stop when a terminal event arrives. If the stream ends or errors without one, wait with exponential backoff (1 s doubling to 30 s, jittered) and reopen with the current `cursor`. On 401 renew credentials first; on 409 for the cursor, call `GET /{id}` and restart from `after=0`; on 404 or 403 give up.
6. Alternatively, poll `GET /{id}` every 1 to 5 seconds until `status` is `completed`, `failed` or `cancelled`, then read `outcome`.

Cancelling or disconnecting is independent: a dropped stream never cancels the run, and `POST /{id}/cancel` is idempotent.
