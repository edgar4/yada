# Durable storage

Yada stores conversations, in-flight runs, and OAuth sessions in SQLite, PostgreSQL, or MySQL. SQLite is the default. All record payloads are encrypted with AES-256-GCM; the encryption key is supplied by your deployment and never stored in the database.

## Configuration

Generate a key once and retain it in your secret manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set `YADA_STORAGE_KEY` to that 64-character hex value. Keep the same key across restarts and application instances. Losing it makes stored records unreadable. Do not regenerate it on startup.

SQLite requires only the key:

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

`runConversation` loads committed text messages and saves the user input and completed answer together. Failed or cancelled runs do not change history. Storage failures propagate; a response is not returned as successful before its history is committed. Concurrent saves raise `StorageConflict` instead of overwriting another turn. Serialize runs per conversation in your host application; conflicts do not trigger automatic model or tool retries.

For direct access, use `storage.conversations.load(identity, id)` and `save(identity, id, messages, expectedRevision)`. Use revision `0` to create a new conversation. Each save returns the next revision. `runConversation` persists completed text exchanges. Use [durable runs](recovery.md) to checkpoint individual executions and resume them after a crash. Callers should manage history length for the selected model's context limit.

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

Opening storage applies versioned migrations under Knex's migration lock. Migration or connection failures stop initialization; there is no fallback to another database. Deploy against a database where the migration account can create the required tables. Back up before upgrades and run one migration opener before scaling application instances.

SQLite uses WAL with a bounded busy timeout and a single connection per storage instance. Keep the database on a persistent local volume, not a shared network filesystem. PostgreSQL and MySQL support deployments using a shared database across hosts.

Back up the database using its native backup tools and retain the encryption key separately. For SQLite, use its backup API or stop all writers before copying the database and WAL files. Restore a backup with the matching key and verify it before replacing production data. See [operations](operations.md) for encrypted snapshots, verified restore, offline key rotation, and conversation erasure. Schedule retention according to your application policy.

The conformance suite runs against real SQLite, PostgreSQL 17, and MySQL 8.4. CI repeats all three. To test external databases locally, set `YADA_TEST_POSTGRES_URL` and `YADA_TEST_MYSQL_URL` to disposable test databases before `npm run check`.
