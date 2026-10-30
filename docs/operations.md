# Operations

## Context, usage and cost reservations

Runtime `limits.maxContextChars` bounds the combined system prompt, normalized messages and tool schemas before each model request. Its default is 64,000 characters. Exceeding it returns the existing `limit` failure without making another request. This is a character safety bound, not a tokenizer-specific context-window calculation.

Service profiles optionally set `historyChars` (default 32,000). The worker retains complete recent exchanges beginning at a user turn; it never starts context with an orphaned tool result. Durable history stays intact in storage. Select bounds appropriate to the configured model.

For an optional per-run spending reservation, set both `limits.maxCostMicros` and `limits.costPerCallMicros`. One million micros is one unit of your accounting currency. The host supplies a conservative maximum cost per call based on its configured model, output limit, context bound and billing rules. Each model attempt reserves that amount durably before dispatch, including attempts interrupted by a crash. Reservations are not refunded automatically. A request that would exceed the configured reservation budget is blocked.

This does not discover provider pricing or guarantee the provider's final invoice. Configure provider-side account limits as well. Actual reported input/output token usage is retained in checkpoints when the provider supplies it; absent usage stays unknown rather than being reported as zero. Profile versions bind these limits for recovery.

## Backup, restore and encryption keys

`backupStorage(config)` returns a versioned encrypted snapshot of all Yada records. The database encryption key is never embedded in the snapshot. Store snapshots and keys separately with restricted access. Snapshots contain encrypted conversations, jobs, runs, approvals and OAuth sessions. Treat them as sensitive even though payloads are encrypted.

`restoreStorage(config, backup)` verifies every envelope with the supplied key and requires an empty destination. Inserts are transactional; a damaged or duplicate record rolls back the restore. Restore into a separate database and verify representative conversations before switching the application to it. Keep the original database available for rollback.

`rotateStorageKey(config, newKey)` re-encrypts records transactionally. **Stop all writers and workers before rotation**, keep a verified backup, then restart every instance with the new key. This is an offline maintenance API, not online rolling rotation. Never mix instances using different keys. Retain the previous key for older backups according to your retention policy.

The conformance suite verifies encrypted backup/restore and key rotation on SQLite, PostgreSQL and MySQL, including rejection of incorrect keys and nonempty restore destinations. SQLite files must stay on persistent local storage; do not copy a live WAL database as an ordinary file backup.

## Retention and erasure

`storage.jobs.prune(identity, conversationId, beforeTimestamp)` removes terminal job/event listings older than the cutoff. It retains conversation history and internal references needed for later full erasure. Retired run IDs cannot be reused.

`storage.retention.eraseConversation(identity, conversationId)` removes conversation content, completed run checkpoints, and associated action records. Cancel or reconcile unfinished runs first. Erasure leaves an empty tombstone to prevent the same conversation ID from being recreated accidentally. Interrupted erasure can be retried; its pending cleanup references remain durable. OAuth grants belong to connections and are managed separately through disconnect/revocation.

Backups and external backend operation receipts have independent retention policies. Erasing Yada records does not revoke provider credentials or delete data in connected services.

## Telemetry and recovery

Worker `trace` callbacks report lifecycle outcomes and elapsed milliseconds without prompts, tokens, actor IDs, or arguments. Send these to your metrics system; use host-owned request correlation if needed. Protect detailed checkpoint inspection as privileged access.

Monitor queued age, repeated retry events, lease failures, awaiting approvals and reconciling actions. Reconciling means an external write's result is uncertain: inspect its authoritative receipt rather than creating another operation. See [service composition](service.md), [approved actions](actions.md) and [run recovery](recovery.md).
