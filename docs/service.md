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

On shutdown, stop accepting new requests, await `worker.stop()`, then close storage. Shutdown leaves active runs recoverable; user cancellation is a separate operation. Start one migration opener before scaling workers. SQLite uses one persistent local volume; PostgreSQL and MySQL support workers on multiple hosts with synchronized clocks.

## HTTP API

All paths start with `/v1/conversations/{conversationId}/runs`. IDs are scoped to the authenticated tenant and actor.

| Method | Suffix                                  | Behavior                                                                                                                                                                                                                                |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/`                                     | Submit `{ id, profileId, input }`; `input` is text or parts (up to 4 images, 5 MB each, text up to 32,000 characters; body cap `maxJobBodyBytes`, about 28 MB); returns 202 after durable commit                                        |
| GET    | `/{id}`                                 | Inspect the run                                                                                                                                                                                                                         |
| GET    | `/{id}/events?after=0`                  | Stream versioned NDJSON events; replay from sequence cursor                                                                                                                                                                             |
| POST   | `/{id}/cancel`                          | Persist a cancellation request                                                                                                                                                                                                          |
| GET    | `/{id}/approvals/{approvalId}`          | Read preview, status and expiry                                                                                                                                                                                                         |
| POST   | `/{id}/approvals/{approvalId}/decision` | Submit `{ approved, remember? }`; `remember` is `"run"` or `"conversation"`. Returns 409 unless the run is awaiting that approval or when the opposite decision was already recorded; repeating an already applied decision returns 202 |

Generate a unique run ID before submission and reuse it when retrying that submission. Reusing it with changed input or profile returns 409. A conversation accepts one unfinished run at a time. Completed answers and conversation history are committed atomically, so recovery cannot append an answer twice. Network disconnection never cancels the run.

Events have `version`, `sequence`, `type`, and `at`, with optional `text`, `code`, `approvalId`, or (on `awaiting_approval`) `expiresAt`. Streams provide lifecycle progress, tool activity and complete answers; they do not expose provider reasoning. Persisted `tool_started` (read tools only, since writes already report approval and reconciliation), `tool_finished` (with `failed`) and `usage` (`inputTokens`, `outputTokens`) events carry the tool name or token counts only, never arguments or content, and do not change the run status. Reconnect using the last processed sequence and discard already processed events. Errors are sanitized and responses are not cacheable.

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
| `GET /{id}/approvals/{approvalId}`           | none                                                                 | 200 `{ id, preview, status, expiresAt }`                                               |
| `POST /{id}/approvals/{approvalId}/decision` | `{ "approved": bool, "remember"?: "run" or "conversation" }`         | 202 `{ "accepted": true }`                                                             |

Errors are `{ "error": string }` with these statuses:

| Status | Meaning                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Invalid request body or parameters                                                                                                          |
| 401    | Authentication required; renew credentials, then retry                                                                                      |
| 403    | Origin or profile denied; do not retry                                                                                                      |
| 404    | Unknown path, run or approval; also the response for runs of another tenant or actor                                                        |
| 409    | Conflict: run ID reused with different input, unfinished run in the conversation, approval not pending, or `after` beyond the stored events |
| 413    | Request body too large                                                                                                                      |
| 429    | Reserved for host rate limiting; Yada's handler does not return it. Honor `Retry-After`, then retry                                         |
| 503    | Temporary failure; retry with backoff                                                                                                       |

Event lines are JSON objects `{ version: 1, sequence, type, at }` plus optional `text`, `code`, `approvalId`, `expiresAt`, `tool`, `failed`, `inputTokens`, `outputTokens`. Types: `queued`, `running`, `progress`, `awaiting_approval`, `reconciling`, `completed`, `failed`, `cancelled`, `tool_started`, `tool_finished`, `usage` and, only on a shared event bus, `text_delta`. Terminal types are `completed` (`text`), `failed` (`code`) and `cancelled`. `tests/fixtures/service-events.ndjson` holds a sample stream that the test suite validates against the event schema.

Submit and follow a run:

1. Generate a run ID and `POST /` with it. After a network error or 5xx, resend the identical body; a 409 for an identical resend means the run already exists, so continue to step 2.
2. Set `cursor = 0`. Open `GET /{id}/events?after={cursor}`.
3. For each line, skip `text_delta` events (they have no persisted sequence) and any event with `sequence <= cursor`; handle the rest and set `cursor = sequence`.
4. On `awaiting_approval`, read the approval, show `preview`, and `POST` the decision before `expiresAt`. The stream keeps running afterwards.
5. Stop when a terminal event arrives. If the stream ends or errors without one, wait with exponential backoff (1 s doubling to 30 s, jittered) and reopen with the current `cursor`. On 401 renew credentials first; on 409 for the cursor, call `GET /{id}` and restart from `after=0`; on 404 or 403 give up.
6. Alternatively, poll `GET /{id}` every 1 to 5 seconds until `status` is `completed`, `failed` or `cancelled`, then read `outcome`.

Cancelling or disconnecting is independent: a dropped stream never cancels the run, and `POST /{id}/cancel` is idempotent.
