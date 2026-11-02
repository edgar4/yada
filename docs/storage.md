---
layout: doc
title: "Durable storage"
description: "Persist Yada conversations, runs, approvals and OAuth sessions with encrypted SQLite, PostgreSQL or MySQL storage and versioned migrations."
---

# Durable storage

Yada stores conversations, in-flight runs, and OAuth sessions in SQLite, PostgreSQL, or MySQL. SQLite is the default. All record payloads are encrypted with AES-256-GCM; the encryption key is supplied by your deployment and never stored in the database.

## Configuration

Generate a key once and retain it in your secret manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set `YADA_STORAGE_KEY` to that 64-character hex value. Keep the same key across restarts and application instances. Losing it makes stored records unreadable. Do not regenerate it on startup.

Each record carries the id of the key that sealed it (`v2.<keyId>...`); older `v1` records stay readable. To rotate without downtime, set `YADA_STORAGE_KEY` to the new key and `YADA_STORAGE_PREVIOUS_KEYS` to a comma-separated list of retired keys (`previousEncryptionKeys` in config). Records are read with any listed key and re-encrypted with the current key whenever they are written. Run `rotateStorageKey` afterwards to re-encrypt the rest, then drop the old keys. Instances from before key ids cannot read newly written records, so upgrade every instance before rotating.

Database drivers are optional peer dependencies. Install the one you use: `better-sqlite3` for SQLite, `pg` for PostgreSQL, `mysql2` for MySQL. Opening storage without it fails with an error naming the package.

SQLite requires only the key and `better-sqlite3`:

```dotenv
YADA_STORAGE_KEY=your-64-character-hex-key
```

It writes `yada.sqlite` in the current directory. Optionally set `YADA_STORAGE_FILE` to a persistent file path. Its parent directory must already exist.

For PostgreSQL:

```dotenv
YADA_STORAGE_DRIVER=postgres
YADA_STORAGE_URL=postgres://user:password@localhost:5432/yada
YADA_STORAGE_KEY=your-64-character-hex-key
```

For MySQL:

```dotenv
YADA_STORAGE_DRIVER=mysql
YADA_STORAGE_URL=mysql://user:password@localhost:3306/yada
YADA_STORAGE_KEY=your-64-character-hex-key
```

Use dedicated database credentials and configure TLS for remote database connections. Database credentials, the storage encryption key, model keys, and OAuth tokens serve different purposes.

## Conversations

```ts
const storage = await createStorage(storageConfigFromEnv(process.env));
try {
  const result = await runConversation({
    store: storage.conversations,
    conversationId: "chat-123",
    identity,
    provider,
    tools,
    input: "Continue our conversation",
    system: "Help the user.",
    signal: AbortSignal.timeout(30_000),
  });
} finally {
  await storage.close();
}
```

Import these functions from Yada's public entry point. Identity must be authenticated by your application. Conversation IDs are scoped to both tenant and actor.

`runConversation` loads the stored history and saves the full turns of a completed run: the user input, assistant turns with their tool calls and provider metadata (such as thinking blocks), tool results and the final answer. Older text-only messages still load. A failed or cancelled run stores the user input plus a `{ role: "failure", code }` marker so the transcript is complete; markers are never sent to the model. Storage failures propagate; a response is not returned as successful before its history is committed. If the save hits a `StorageConflict`, `runConversation` reloads the conversation and retries the save once, appending the turns to the latest messages; a second conflict propagates. Serialize runs per conversation in your host application; conflicts do not trigger automatic model or tool retries.

For direct access, use `storage.conversations.load(identity, id)` and `save(identity, id, messages, expectedRevision)`. Use revision `0` to create a new conversation. Each save returns the next revision. `runConversation` persists complete turns including tool calls and results. Use [durable runs](recovery.md) to checkpoint individual executions and resume them after a crash. Callers should manage history length for the selected model's context limit.

## Long-term memory

`storage.memory` keeps short notes per `(tenantId, actorId)` in one encrypted record, so memory never crosses actors or tenants. It offers `put(identity, { key, text, tags? })` (upsert by key), `get`, `list`, `delete` and `search(identity, query, limit)`. Search is a case-insensitive substring match on key and text, or an exact tag match; there are no embeddings. Writes are revision-checked and retried, so caps hold under concurrency: 4 KiB per item, 200 items and 256 KiB per actor. Exceeding a cap throws.

`memoryTools(storage.memory)` returns `memory_search` (read), and `memory_save` and `memory_forget` (writes that wait for approval, or follow your tool policy). Results come back as tool output, truncated by `maxToolOutput`, and are never added to the system prompt. Erase an actor's memory with `storage.retention.eraseActorMemory(identity)`.

For an external knowledge source, implement `Retriever` (`search(identity, query, signal)` returning `{ id, text, source?, score? }[]`) and pass it to `retrievalTool(retriever)`, a read tool whose output is untrusted text.

## OAuth sessions

Pass `storage.oauth` as the store to `createMcpOAuth`. It implements atomic field merging and single-use state consumption, and preserves issuer stamps and provider metadata across restarts. See [MCP OAuth](mcp-oauth.md) for callback integration and per-session serialization requirements.

```ts
const oauth = createMcpOAuth({
  serverUrl,
  redirectUrl,
  identity,
  store: storage.oauth,
  redirect,
});
```

## Operations

Opening storage applies versioned migrations under Knex's migration lock. Migration or connection failures stop initialization; there is no fallback to another database. Deploy against a database where the migration account can create the required tables. Back up before upgrades and run one migration opener before scaling application instances: call `migrateDatabase(config)` once (a deploy step or init container), then start instances with `createStorage(config, { migrate: false })` so they skip migrations. Migration also backfills the conversation `kind` and `active` columns from existing records in batches; stop older application versions first, since they do not maintain `active`.

Workers find unfinished jobs through an indexed `active` flag on conversation records, so polling cost scales with active conversations and no shared row is rewritten. Jobs store only the number of history messages they started from and derive history from the conversation. Events, steering and history of terminal jobs beyond the latest 20 per conversation are dropped; outcomes are kept.

Writes that fail with a serialization failure or deadlock (PostgreSQL `40001`/`40P01`, MySQL `1213`/`1205`) are retried like revision conflicts.

SQLite uses WAL with a bounded busy timeout and a single connection per storage instance. Keep the database on a persistent local volume, not a shared network filesystem. PostgreSQL and MySQL support deployments using a shared database across hosts.

Back up the database using its native backup tools and retain the encryption key separately. For SQLite, use its backup API or stop all writers before copying the database and WAL files. Restore a backup with the matching key and verify it before replacing production data. See [operations](operations.md) for encrypted snapshots, verified restore, offline key rotation, and conversation erasure. Schedule retention according to your application policy.

The conformance suite runs against real SQLite, PostgreSQL 17, and MySQL 8.4. CI repeats all three. To test external databases locally, set `YADA_TEST_POSTGRES_URL` and `YADA_TEST_MYSQL_URL` to disposable test databases before `npm run check`.
