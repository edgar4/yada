---
layout: doc
title: "Durable runs and recovery"
---

# Durable runs and recovery

`runDurable` persists in-flight execution in the same encrypted storage used for conversations and OAuth. SQLite, PostgreSQL, and MySQL share the same API and recovery behavior.

```ts
import { createStorage, storageConfigFromEnv, runDurable } from "yada";

const storage = await createStorage(storageConfigFromEnv(process.env));
try {
  const result = await runDurable({
    store: storage.runs,
    runId: job.id,
    profileId: "support-agent-v1",
    identity,
    provider,
    tools,
    input: job.input,
    system: "Help the user.",
    signal: AbortSignal.timeout(60_000),
  });
} finally {
  await storage.close();
}
```

Use your installation's import path for Yada. Supply authenticated identity and a stable run ID from your application's durable job or request record. IDs are scoped to tenant and actor. `profileId` identifies your model configuration and tool implementation version; change it when those behaviors change. It is not a credential.

## Restarting a worker

After a crash, your host resubmits the same `runDurable` call with the same identity, run ID, input, system prompt, profile, provider, tools, and limits. Recreate provider adapters and MCP connections before resuming. Keep the matching configuration available for unfinished runs; configuration mismatches are rejected.

Yada resumes saved pending calls and retains completed tool results, provider message metadata, call IDs, and execution budgets. It rechecks authorization before executing pending calls. A completed, failed, or cancelled run returns its saved outcome without calling the model again. Use a new run ID for a new attempt after a terminal outcome.

When using `runDurable` directly, the host owns the durable job queue, retry scheduling, and discovery of unfinished job IDs. Use [the service worker](service.md) for automatic discovery, scheduling, and conversation projection. `storage.runs.load(identity, runId)` exposes the stored request, checkpoint, and lease for host-side inspection. `runDurable` does not automatically append its answer to `runConversation` history; the host owns any projection into conversation history.

## Leases and failures

A worker claims a lease before execution and renews it while running. The default duration is 30 seconds; `leaseMs` accepts 100–300,000 milliseconds. Use a duration comfortably above expected database latency and event-loop pauses. Across hosts, keep clocks synchronized.

Competing claims raise `RunLeaseError` while a lease remains active. After a crash, retry after expiry. Each new claim receives a unique token; stale workers cannot overwrite the replacement worker's checkpoint. Database compare-and-swap checks prevent lost updates.

Failure to persist a checkpoint raises `CheckpointError`; no successful answer is returned before its outcome is committed. Lease-renewal failures abort execution and leave the run recoverable after expiry. Cancellation requested by the caller is persisted. If a write has an uncertain result, the run remains reconciling until its receipt resolves; cancellation cannot discard that evidence. Ordinary model or tool errors otherwise produce terminal `dependency_failed` outcomes.

## Replay boundaries

Model decisions are saved before tools execute. Each tool result is saved before the next tool or model call. A crash after execution but before the result is committed can repeat that read. A model request interrupted before its response is saved can also repeat and incur provider charges. Model attempts consume the round budget before dispatch, including interrupted attempts.

Use [approved write tools](actions.md) with `actionExecutor` for mutations. Durable execution binds the executor to the current lease and fences the transition into execution. Once a write starts, recovery looks up its receipt instead of replaying it. Tool handlers must honor cancellation; losing a lease cannot stop an external operation that ignores its signal. Keep write operations out of read-tool handlers.

## Verification

The database conformance suite kills a real worker process with `SIGKILL`, restarts execution, and checks that committed reads are not repeated. It also covers concurrent claims, stale-worker fencing, lost responses after committed decisions, heartbeat renewal and failure, configuration matching, and tenant isolation on all three database engines. CI runs this suite alongside formatting, lint, type checks, coverage, and compilation.
