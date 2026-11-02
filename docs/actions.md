---
layout: doc
title: "Approved actions"
description: "Build approved write tools in Yada with exact action previews, authenticated decisions, version checks, operation IDs and receipt reconciliation."
---

# Approved actions

Define mutating tools with `writeTool`, including a schema, tool version, authorization, preparation, execution, and receipt lookup. Use `createWorker` to connect these tools to durable approvals, or supply `actionExecutor(storage.actions, identity, runId)` to `runDurable`.

Preparation returns `{ preview, version }`. The preview describes the exact proposed change to the user. The version identifies the backend state on which the proposal depends. Preparation must not mutate the target system.

Execution receives validated arguments and `{ identity, signal, operationId, version }`. The backend must enforce the state version atomically with the change and use `operationId` as its idempotency key. Recheck business authorization in the backend. Return a receipt string. `reconcile(operationId, identity, signal)` returns the authoritative receipt or `undefined` when the outcome is still unknown.

Yada binds approval to the authenticated tenant and actor, run, tool call, exact arguments, tool implementation version, prepared state version, and expiry. Chat text does not approve an action. Only the explicit decision endpoint changes approval state. The default approval lifetime is ten minutes.

Before execution, Yada rechecks authorization and prepared state. Duplicate decisions cannot execute an action twice. Once execution starts, subsequent recovery checks the receipt; it does not issue the write again. A lost response produces `reconciling`, including when cancellation interrupts an already-started write. Cancellation cannot undo an external change.

Persist operation receipts in the system that owns the mutation. If the backend cannot resolve an ambiguous result, the run remains reconciling for operator investigation; do not retry it under a new operation ID. A new tool version or changed arguments require a new proposal. Do not implement writes through `readTool` or read-only MCP annotations.

## Tool policy and confirmation

`confirmTool(tool, { preview? })` wraps any `readTool`-shaped tool as a write tool, so it needs approval before each call. The preview defaults to the tool name and JSON arguments; pass `preview(args)` to customize it. Its version is the tool name plus a hash of its input schema.

`applyToolPolicy(tools, policy)` maps tool names or `*` globs (for example `server__*`) to `allow`, `ask` or `deny`. An exact name beats a glob, and a longer glob beats a shorter one. `deny` removes the tool, `ask` wraps read tools with `confirmTool` (write tools always ask) and unmatched tools are allowed.

`reconcile` is optional. Without it, an execution whose outcome is uncertain (a thrown error, cancellation, or a crash after execution began) marks the action `unknown` and returns `Action outcome unknown; it may or may not have been applied. Do not retry automatically.` as the tool result. The write is never repeated. Confirmed read tools have no `reconcile`.

## Remembered approvals

A decision may include `remember: "run" | "conversation"`. Later actions with the same tool name, tool version and identical arguments are approved automatically within that run, or within any run of that same conversation. Grants belong to the authenticated tenant and actor and never apply to another conversation or identity. Auto-approved actions still recheck authorization and prepared state before executing. Declined or expired decisions are never remembered. Conversation grants have no expiry; they last until the conversation is erased, so offer `"conversation"` only for low-risk tools.

Set the approval lifetime with the `ttlMs` argument of `actionExecutor` or the worker profile `approvalTtlMs`. A run waiting for approval is woken when that lifetime ends.

## MCP elicitation

When an [MCP server](mcp.md#sampling-and-elicitation) with `elicitation: true` asks the user a question during a read tool call, the run suspends as `awaiting_approval` with an action whose preview is the JSON of `{ message, requestedSchema }`. The decision body takes an optional `content` object:

```json
{ "approved": true, "content": { "name": "Ada" } }
```

Approval requires `content` to validate against the requested schema (JSON Schema, Ajv); otherwise the endpoint returns `400` and the approval stays pending. `content` is rejected on any other action. Declining answers the server with `decline`; expiry answers with `cancel`.

On resume the tool call is re-issued, so the server asks again and receives the stored answer. Each question has an operation ID derived from the run, tool call and question index; the answer is claimed through the same lease-fenced transition as writes, so a worker that lost its lease cannot answer. Elicited values live only in the action record (encrypted with the rest of the storage) and are never put in events, logs or the preview endpoint.

## Sub-agent writes

A [sub-agent](architecture.md#sub-agents) built with `agentTool` may use write tools when the run is durable. Its actions are recorded on the parent run with the call ID `sub:<parent call ID>:<call ID>` (nested sub-agents extend the prefix), so the approval endpoints, remembered approvals and lease fencing behave exactly as for the parent's own writes. The parent suspends with the sub-agent's approval ID; after the decision the parent re-issues the agent tool call and the sub-agent resumes from its checkpoint and executes the approved action once.
