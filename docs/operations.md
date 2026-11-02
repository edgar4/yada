---
layout: doc
title: "Operations"
description: "Operate Yada with context and usage limits, encrypted backups, verified restore, key rotation, retention, erasure and recovery monitoring."
---

# Operations

## Context, usage and cost reservations

Runtime `limits.maxContextChars` bounds the combined system prompt, normalized messages and tool schemas before each model request. Its default is 256,000 characters. When it is still exceeded after tool-result compaction, the run fails with `limit` without making another request, unless `summarize` is set (see [architecture](architecture.md#limits-and-hooks)). This is a character safety bound, not a tokenizer-specific context-window calculation.

Service profiles optionally set `historyChars` (default 128,000). The worker retains complete recent exchanges beginning at a user turn; it never starts context with an orphaned tool result. Tool results older than the newest `historyToolChars` (default 16,000) characters are replaced with `[compacted: N chars]` rather than dropping whole exchanges. Durable history keeps full turns (assistant tool calls, provider metadata and tool results) for completed runs and a failure marker for failed or cancelled runs; the run API returns only user and final assistant text. Select bounds appropriate to the configured model.

For an optional per-run spending reservation, set both `limits.maxCostMicros` and `limits.costPerCallMicros`. One million micros is one unit of your accounting currency. The host supplies a conservative maximum cost per call based on its configured model, output limit, context bound and billing rules. Each model attempt reserves that amount durably before dispatch, including attempts interrupted by a crash. Reservations are not refunded automatically. A request that would exceed the configured reservation budget is blocked.

To bound spending by what the provider reports instead, set `limits.pricing` (`inputMicrosPer1k`, `outputMicrosPer1k`) with `maxCostMicros`; `costPerCallMicros` is then optional. Optional `cacheReadMicrosPer1k` and `cacheWriteMicrosPer1k` price cached input tokens; without them cached tokens are priced as input. Before each model request the run's accumulated reported usage is priced, and the run ends with `limit` once the cost reaches `maxCostMicros`. Calls whose provider reports no usage count as zero, so keep `costPerCallMicros` as a backstop for such providers. Provider-hosted web search, on by default for Anthropic, OpenAI and Gemini, is billed per search by the provider and not included in these limits; cap it with `webSearch.maxUses` or turn it off with `YADA_LLM_SERVER_TOOLS=none`.

This does not discover provider pricing or guarantee the provider's final invoice. Configure provider-side account limits as well. Actual reported input/output token usage is retained in checkpoints when the provider supplies it; absent usage stays unknown rather than being reported as zero. Profile versions bind these limits for recovery.

## Tenant quotas

Per-run limits do not bound a tenant over time. Pass `quota` to `createHandler` and the same value to `createWorker`:

```ts
const quota = {
  requests: { limit: 100, windowMs: 3_600_000 },
  costMicros: { limit: 5_000_000, windowMs: 86_400_000 },
  scope: "tenant",
};
```

`scope` is `"tenant"` (default, shared by all actors) or `"actor"`. Counters are fixed windows kept in storage, so they hold across instances; one record per scope holds only the current window. `POST .../runs` consumes one request unit; resubmitting an existing run ID does not. Once a window is exhausted, or the cost window is at or over `limit`, submission returns `429` with `Retry-After` (seconds until the window ends) and `{ "error": "Rate limit exceeded" }`.

The worker adds each finished run's reported usage, priced with the profile `limits.pricing` (including cache pricing), to the cost window. Runs of profiles without `pricing` or without reported usage add nothing. A run already in flight is never stopped, so spend can overshoot `limit` by one run. Without `quota`, nothing changes. Other endpoints, including steering messages, do not consume quota. Handler and worker must use the same `quota`; a worker without it does not accrue cost.

## Backup, restore and encryption keys

SQLite maintenance requires a persistent database filename. These config-based APIs open their own connection and reject `:memory:`, which would address a different empty database.

`backupStorage(config)` returns a versioned encrypted snapshot of all Yada records, reading them in batches of 100. For large databases use `streamBackup(config)`, an async iterator of record batches, to write the snapshot incrementally. The database encryption key is never embedded in the snapshot. Store snapshots and keys separately with restricted access. Snapshots contain encrypted conversations, jobs, runs, approvals, long-term memory and OAuth sessions. Treat them as sensitive even though payloads are encrypted.

`restoreStorage(config, backup)` verifies every envelope with the supplied key and requires an empty destination. Inserts are transactional; a damaged or duplicate record rolls back the restore. Restore into a separate database and verify representative conversations and memory before switching the application to it. Keep the original database available for rollback.

`rotateStorageKey(config, newKey)` re-encrypts records in batches of 100, one transaction per batch, and skips records already under the new key, so an interrupted run can be repeated. Config keys and `previousEncryptionKeys` are used for reading. For online rotation, deploy instances with the new key as `encryptionKey` and the old key in `previousEncryptionKeys`, then run `rotateStorageKey({ ...config, encryptionKey: newKey, previousEncryptionKeys: [oldKey] }, newKey)`; a record changed concurrently fails the batch with a message to rerun. Without previous keys it remains an offline operation: stop writers, keep a verified backup, restart with the new key. Never mix instances using different keys without listing the old one as previous. Retain the previous key for older backups according to your retention policy.

The conformance suite verifies encrypted backup/restore and key rotation on SQLite, PostgreSQL and MySQL, including rejection of incorrect keys and nonempty restore destinations. SQLite files must stay on persistent local storage; do not copy a live WAL database as an ordinary file backup.

## Retention and erasure

`storage.jobs.prune(identity, conversationId, beforeTimestamp)` removes terminal job/event listings older than the cutoff. It retains conversation history and internal references needed for later full erasure. Retired run IDs cannot be reused.

`storage.retention.eraseConversation(identity, conversationId)` removes conversation content, completed run checkpoints, and associated action records. Cancel or reconcile unfinished runs first. Erasure leaves an empty tombstone to prevent the same conversation ID from being recreated accidentally. Interrupted erasure can be retried; its pending cleanup references remain durable. OAuth grants belong to connections and are managed separately through disconnect/revocation.

`storage.retention.eraseActorMemory(identity)` deletes that actor's long-term memory record. Memory is a normal record, so backups and restores include it.

Backups and external backend operation receipts have independent retention policies. Erasing Yada records does not revoke provider credentials or delete data in connected services.

## Telemetry and recovery

Worker `trace` callbacks report lifecycle outcomes, attempt number, failure code, elapsed milliseconds, rounds, tool call count and reported input/output token totals without prompts, actor IDs, or arguments.

For per-run tracing, pass `hooks: tracingHooks(tracer, { provider, model })` to `run` (or a profile). `tracer` is any object with `startSpan(name, attributes?, parent?)` returning `{ setAttribute, setStatus, end }`, so any tracing backend can be adapted.

For OpenTelemetry, install `@opentelemetry/api` (optional peer) and configure your SDK and exporter yourself; Yada ships neither. Import `otelTracer` from `@edgaralochi/yada/otel`: `const tracer = await otelTracer();` returns a tracer for `trace.getTracer("yada")`, and `hooks: composeHooks(tracingHooks(tracer, info), yourHooks)` wires it in. Tool and model spans are children of `yada.run` through `trace.setSpan`; attributes pass through and `ok`/`error` map to `SpanStatusCode`. Without the package, `otelTracer()` throws with the install command.

Create one instance per run. It emits a `yada.run` span (`run.status`, `run.code`) with child `yada.model` spans (`model.provider`, `model.name`, `model.finish_reason`, token usage) and `yada.tool` spans (`tool.name`, `tool.effect`, `tool.outcome`: `ok`, `denied`, `invalid_arguments`, `unknown_tool`, `tool_failed`). Arguments, tool output and model text are never recorded. Use `composeHooks(tracing, yourHooks)` to combine with other hooks. A run that suspends (`awaiting_approval`, `reconciling`) ends its open spans with `run.status` set to the suspended status and an ok span status; resuming starts a new `yada.run` span. Send these to your metrics system; use host-owned request correlation if needed. Protect detailed checkpoint inspection as privileged access.

Workers discover jobs through an indexed `active` flag on conversation records, so polling cost scales with active conversations, not total history. Records from earlier versions are backfilled when storage is first opened (see [storage](storage.md)); the old `job_queue` record is deleted.

Trace callback failures do not interrupt workers. Job status updates, including terminal outcomes and retries, are fenced by the current run lease in the same database transaction, so an expired worker cannot overwrite a newer worker's approval state. Repetitive progress events are capped; approval and terminal events remain deliverable.

Monitor queued age, repeated retry events, lease failures, awaiting approvals and reconciling actions. Reconciling means an external write's result is uncertain: inspect its authoritative receipt rather than creating another operation. See [service composition](service.md), [approved actions](actions.md) and [run recovery](recovery.md).
