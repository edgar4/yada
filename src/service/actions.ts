import { abortable } from "../core/abort.js";
import {
  elicitationTool,
  type ActionExecutor,
  type Suspension,
} from "../core/action.js";
import type { Identity } from "../core/contracts.js";
import { ToolCallError } from "../core/tool.js";
import {
  operationId,
  undeliveredOutcome,
  unknownOutcome,
  type ActionStore,
  type RememberScope,
} from "../storage/actions.js";
import { CheckpointError } from "../core/checkpoint.js";
export function actionExecutor(
  store: ActionStore,
  identity: Identity,
  runId: string,
  ttlMs = 600_000,
  leaseToken?: string,
  rememberScopes?: readonly RememberScope[],
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
        status: (await store.remembered(
          identity,
          runId,
          tool.spec.name,
          tool.version,
          call.args,
          rememberScopes,
        ))
          ? "approved"
          : "pending",
      });
    }
    if (
      state.toolVersion !== tool.version ||
      state.tool !== call.name ||
      JSON.stringify(state.args) !== JSON.stringify(call.args)
    )
      throw new Error("Action mismatch");
    if (["completed", "unknown", "undelivered"].includes(state.status))
      return state.receipt ?? "";
    const unresolved = async (): Promise<string | Suspension> => {
      if (tool.reconcile) return { status: "reconciling", approvalId: id };
      await store.unknown(identity, id);
      return unknownOutcome;
    };
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
        } catch (error) {
          if (error instanceof ToolCallError && error.delivery === "not_sent") {
            await store.undelivered(identity, id);
            return undeliveredOutcome;
          }
          return unresolved();
        }
      }
      state = await store.load(identity, id);
      if (state?.status === "expired")
        return "Action approval expired; no change was made.";
    }
    if (!tool.reconcile) return unresolved();
    const reconcile = tool.reconcile.bind(tool);
    let receipt: string | undefined;
    try {
      receipt = await abortable(() => reconcile(id, identity, signal), signal);
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
  execute.ask = (call) => {
    let asked = 0;
    return async (request) => {
      const id = operationId(
        identity,
        runId,
        `${call.id}:ask:${String(asked++)}`,
      );
      let state =
        (await store.load(identity, id)) ??
        (await store.propose(identity, {
          id,
          runId,
          callId: call.id,
          tool: elicitationTool,
          toolVersion: "1",
          args: request,
          preview: JSON.stringify(request).slice(0, 32_000),
          version: "1",
          expiresAt: Date.now() + ttlMs,
          status: "pending",
        }));
      if (state.status === "pending" && state.expiresAt <= Date.now())
        state = await store.decide(identity, id, false);
      if (state.status === "pending")
        return { status: "awaiting_approval", approvalId: id };
      if (state.status === "approved") {
        try {
          if (
            await store.begin(
              identity,
              id,
              leaseToken === undefined
                ? undefined
                : { runId, token: leaseToken },
            )
          )
            await store.receipt(identity, id, "answered");
        } catch {
          throw new CheckpointError();
        }
        state = (await store.load(identity, id)) ?? state;
      }
      if (state.status === "declined") return { action: "decline" };
      return state.content
        ? { action: "accept", content: state.content }
        : { action: "cancel" };
    };
  };
  execute.withLease = (token) =>
    actionExecutor(store, identity, runId, ttlMs, token, rememberScopes);
  return execute;
}
