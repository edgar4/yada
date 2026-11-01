---
layout: doc
title: "Operations"
description: "Operate Yada with context and usage limits, encrypted backups, verified restore, key rotation, retention, erasure and recovery monitoring."
---

# Operations

## Context, usage and cost reservations

Runtime `limits.maxContextChars` bounds the combined system prompt, normalized messages and tool schemas before each model request. Its default is 256,000 characters. Exceeding it returns the existing `limit` failure without making another request. This is a character safety bound, not a tokenizer-specific context-window calculation.

Service profiles optionally set `historyChars` (default 128,000). The worker retains complete recent exchanges beginning at a user turn; it never starts context with an orphaned tool result. Tool results older than the newest `historyToolChars` (default 16,000) characters are replaced with `[compacted: N chars]` rather than dropping whole exchanges. Durable history keeps full turns (assistant tool calls, provider metadata and tool results) for completed runs and a failure marker for failed or cancelled runs; the run API returns only user and final assistant text. Select bounds appropriate to the configured model.

For an optional per-run spending reservation, set both `limits.maxCostMicros` and `limits.costPerCallMicros`. One million micros is one unit of your accounting currency. The host supplies a conservative maximum cost per call based on its configured model, output limit, context bound and billing rules. Each model attempt reserves that amount durably before dispatch, including attempts interrupted by a crash. Reservations are not refunded automatically. A request that would exceed the configured reservation budget is blocked.

To bound spending by what the provider reports instead, set `limits.pricing` (`inputMicrosPer1k`, `outputMicrosPer1k`) with `maxCostMicros`; `costPerCallMicros` is then optional. Before each model request the run's accumulated reported usage is priced, and the run ends with `limit` once the cost reaches `maxCostMicros`. Calls whose provider reports no usage count as zero, so keep `costPerCallMicros` as a backstop for such providers.

This does not discover provider pricing or guarantee the provider's final invoice. Configure provider-side account limits as well. Actual reported input/output token usage is retained in checkpoints when the provider supplies it; absent usage stays unknown rather than being reported as zero. Profile versions bind these limits for recovery.

## Backup, restore and encryption keys

SQLite maintenance requires a persistent database filename. These config-based APIs open their own connection and reject `:memory:`, which would address a different empty database.

`backupStorage(config)` returns a versioned encrypted snapshot of all Yada records. The database encryption key is never embedded in the snapshot. Store snapshots and keys separately with restricted access. Snapshots contain encrypted conversations, jobs, runs, approvals and OAuth sessions. Treat them as sensitive even though payloads are encrypted.

`restoreStorage(config, backup)` verifies every envelope with the supplied key and requires an empty destination. Inserts are transactional; a damaged or duplicate record rolls back the restore. Restore into a separate database and verify representative conversations before switching the application to it. Keep the original database available for rollback.

`rotateStorageKey(config, newKey)` re-encrypts records transactionally. **Stop all writers and workers before rotation**, keep a verified backup, then restart every instance with the new key. This is an offline maintenance API, not online rolling rotation. Never mix instances using different keys. Retain the previous key for older backups according to your retention policy.

The conformance suite verifies encrypted backup/restore and key rotation on SQLite, PostgreSQL and MySQL, including rejection of incorrect keys and nonempty restore destinations. SQLite files must stay on persistent local storage; do not copy a live WAL database as an ordinary file backup.

## Retention and erasure

`storage.jobs.prune(identity, conversationId, beforeTimestamp)` removes terminal job/event listings older than the cutoff. It retains conversation history and internal references needed for later full erasure. Retired run IDs cannot be reused.

`storage.retention.eraseConversation(identity, conversationId)` removes conversation content, completed run checkpoints, and associated action records. Cancel or reconcile unfinished runs first. Erasure leaves an empty tombstone to prevent the same conversation ID from being recreated accidentally. Interrupted erasure can be retried; its pending cleanup references remain durable. OAuth grants belong to connections and are managed separately through disconnect/revocation.

Backups and external backend operation receipts have independent retention policies. Erasing Yada records does not revoke provider credentials or delete data in connected services.

## Telemetry and recovery

Worker `trace` callbacks report lifecycle outcomes, attempt number, failure code, elapsed milliseconds, rounds, tool call count and reported input/output token totals without prompts, actor IDs, or arguments.

For per-run tracing, pass `hooks: tracingHooks(tracer, { provider, model })` to `run` (or a profile). `tracer` is any object with `startSpan(name, attributes?, parent?)` returning `{ setAttribute, setStatus, end }`, so an OpenTelemetry adapter is a few lines and Yada adds no dependency. Create one instance per run. It emits a `yada.run` span (`run.status`, `run.code`) with child `yada.model` spans (`model.provider`, `model.name`, `model.finish_reason`, token usage) and `yada.tool` spans (`tool.name`, `tool.effect`, `tool.outcome`: `ok`, `denied`, `invalid_arguments`, `unknown_tool`, `tool_failed`). Arguments, tool output and model text are never recorded. Use `composeHooks(tracing, yourHooks)` to combine with other hooks. Send these to your metrics system; use host-owned request correlation if needed. Protect detailed checkpoint inspection as privileged access.

Workers discover jobs through a small `job_queue` index of conversations with unfinished jobs, so polling cost scales with active conversations, not total history. A missing index (for example in a database from an earlier version) is rebuilt automatically from a single full scan, and stale entries are dropped on read. Backups include the index.

Trace callback failures do not interrupt workers. Job status updates are fenced by the current run lease in the same database transaction, so an expired worker cannot overwrite a newer worker's approval state. Repetitive progress events are capped; approval and terminal events remain deliverable.

Monitor queued age, repeated retry events, lease failures, awaiting approvals and reconciling actions. Reconciling means an external write's result is uncertain: inspect its authoritative receipt rather than creating another operation. See [service composition](service.md), [approved actions](actions.md) and [run recovery](recovery.md).
