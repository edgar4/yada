import { abortable } from "../core/abort.js";
import type { ActionExecutor } from "../core/action.js";
import type { Identity } from "../core/contracts.js";
import { operationId, type ActionStore } from "../storage/actions.js";
import { CheckpointError } from "../core/checkpoint.js";
export function actionExecutor(
  store: ActionStore,
  identity: Identity,
  runId: string,
  ttlMs = 600_000,
  leaseToken?: string,
): ActionExecutor {
  const execute: ActionExecutor = async (tool, call, signal) => {
    const id = operationId(identity, runId, call.id);
    let state = await store.load(identity, id);
    if (!state) {
      const prepared = await abortable(
        () => tool.prepare(call.args, identity, signal),
        signal,
      );
      state = await store.propose(identity, {
        id,
        runId,
        callId: call.id,
        tool: tool.spec.name,
        toolVersion: tool.version,
        args: call.args,
        ...prepared,
        expiresAt: Date.now() + ttlMs,
        status: "pending",
      });
    }
    if (
      state.toolVersion !== tool.version ||
      state.tool !== call.name ||
      JSON.stringify(state.args) !== JSON.stringify(call.args)
    )
      throw new Error("Action mismatch");
    if (state.status === "completed") return state.receipt ?? "";
    if (state.status === "pending" && state.expiresAt <= Date.now())
      state = await store.decide(identity, id, false);
    if (state.status === "pending")
      return { status: "awaiting_approval", approvalId: id };
    if (state.status === "declined" || state.status === "expired")
      return "Action declined or expired; no change was made.";
    if (state.status === "approved") {
      const current = await abortable(
        () => tool.prepare(call.args, identity, signal),
        signal,
      );
      if (current.version !== state.version)
        throw new Error("Action state changed; prepare a new action");
      if (!(await abortable(() => tool.authorize(identity), signal)))
        throw new Error("Action permission revoked");
      signal.throwIfAborted();
      let began: boolean;
      try {
        began = await store.begin(
          identity,
          id,
          leaseToken === undefined ? undefined : { runId, token: leaseToken },
        );
      } catch {
        throw new CheckpointError();
      }
      if (began) {
        try {
          const receipt = await abortable(
            () =>
              tool.execute(call.args, {
                identity,
                signal,
                operationId: id,
                version: current.version,
              }),
            signal,
          );
          await store.receipt(identity, id, receipt);
          return receipt;
        } catch {
          return { status: "reconciling", approvalId: id };
        }
      }
      state = await store.load(identity, id);
      if (state?.status === "expired")
        return "Action approval expired; no change was made.";
    }
    let receipt: string | undefined;
    try {
      receipt = await abortable(
        () => tool.reconcile(id, identity, signal),
        signal,
      );
    } catch {
      return { status: "reconciling", approvalId: id };
    }
    if (receipt === undefined) return { status: "reconciling", approvalId: id };
    await store.receipt(identity, id, receipt);
    return receipt;
  };
  execute.unresolved = async (call) => {
    const id = operationId(identity, runId, call.id);
    const action = await store.load(identity, id);
    return action?.status === "executing"
      ? { status: "reconciling", approvalId: id }
      : undefined;
  };
  execute.withLease = (token) =>
    actionExecutor(store, identity, runId, ttlMs, token);
  return execute;
}
