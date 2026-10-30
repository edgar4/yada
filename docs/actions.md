# Approved actions

Define mutating tools with `writeTool`, including a schema, tool version, authorization, preparation, execution, and receipt lookup. Use `createWorker` to connect these tools to durable approvals, or supply `actionExecutor(storage.actions, identity, runId)` to `runDurable`.

Preparation returns `{ preview, version }`. The preview describes the exact proposed change to the user. The version identifies the backend state on which the proposal depends. Preparation must not mutate the target system.

Execution receives validated arguments and `{ identity, signal, operationId, version }`. The backend must enforce the state version atomically with the change and use `operationId` as its idempotency key. Recheck business authorization in the backend. Return a receipt string. `reconcile(operationId, identity, signal)` returns the authoritative receipt or `undefined` when the outcome is still unknown.

Yada binds approval to the authenticated tenant and actor, run, tool call, exact arguments, tool implementation version, prepared state version, and expiry. Chat text does not approve an action. Only the explicit decision endpoint changes approval state. The default approval lifetime is ten minutes.

Before execution, Yada rechecks authorization and prepared state. Duplicate decisions cannot execute an action twice. Once execution starts, subsequent recovery checks the receipt; it does not issue the write again. A lost response produces `reconciling`, including when cancellation interrupts an already-started write. Cancellation cannot undo an external change.

Persist operation receipts in the system that owns the mutation. If the backend cannot resolve an ambiguous result, the run remains reconciling for operator investigation; do not retry it under a new operation ID. A new tool version or changed arguments require a new proposal. Do not implement writes through `readTool` or read-only MCP annotations.
