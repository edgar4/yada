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

| Method | Suffix                                  | Behavior                                                            |
| ------ | --------------------------------------- | ------------------------------------------------------------------- |
| POST   | `/`                                     | Submit `{ id, profileId, input }`; returns 202 after durable commit |
| GET    | `/{id}`                                 | Inspect the run                                                     |
| GET    | `/{id}/events?after=0`                  | Stream versioned NDJSON events; replay from sequence cursor         |
| POST   | `/{id}/cancel`                          | Persist a cancellation request                                      |
| GET    | `/{id}/approvals/{approvalId}`          | Read preview, status and expiry                                     |
| POST   | `/{id}/approvals/{approvalId}/decision` | Submit `{ approved: true }` or `{ approved: false }`                |

Generate a unique run ID before submission and reuse it when retrying that submission. Reusing it with changed input or profile returns 409. A conversation accepts one unfinished run at a time. Completed answers and conversation history are committed atomically, so recovery cannot append an answer twice. Network disconnection never cancels the run.

Events have `version`, `sequence`, `type`, and `at`, with optional `text`, `code`, or `approvalId`. Streams provide lifecycle progress and complete answers; they do not expose provider reasoning or token-by-token model output. Reconnect using the last processed sequence and discard already processed events. Errors are sanitized and responses are not cacheable.

`createWorker` discovers queued and interrupted jobs from encrypted storage. Missing profile versions remain queued until that configuration is restored. Profiles must stay stable for unfinished jobs. Lease conflicts defer execution to the owning worker. `tick()` supports externally scheduled workers; `start()` polls automatically. `trace` receives only event name, status and duration, without prompts, identity, credentials, or tool arguments.
