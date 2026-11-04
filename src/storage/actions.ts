import { createHash } from "node:crypto";
import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import { conversationOf, type recordStore } from "./records.js";
import {
  withRunLease,
  RunLeaseError,
  subRunId,
  type RunOwnership,
  type RunStore,
} from "./runs.js";
import { subPrefix } from "../core/action.js";
export const actionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  callId: z.string(),
  tool: z.string(),
  toolVersion: z.string(),
  args: z.unknown(),
  preview: z.string().max(32_000),
  version: z.string(),
  expiresAt: z.number(),
  status: z.enum([
    "pending",
    "approved",
    "declined",
    "executing",
    "completed",
    "expired",
    "unknown",
    "undelivered",
  ]),
  receipt: z.string().max(32_000).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
});
export type Action = z.infer<typeof actionSchema>;
export const operationId = (
  identity: Identity,
  runId: string,
  callId: string,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([identity.tenantId, identity.actorId, runId, callId]),
    )
    .digest("hex");
export async function runTree(
  runs: Pick<RunStore, "load">,
  identity: Identity,
  rootId: string,
  pendingOnly = false,
) {
  const tree = { runIds: [] as string[], actionIds: [] as string[] };
  const walk = async (runId: string, prefix: string): Promise<void> => {
    tree.runIds.push(runId);
    const checkpoint = (await runs.load(identity, runId))?.checkpoint;
    const calls = pendingOnly
      ? (checkpoint?.pending ?? [])
      : (checkpoint?.messages ?? []).flatMap((turn) =>
          turn.role === "assistant" ? turn.toolCalls : [],
        );
    for (const call of calls) {
      tree.actionIds.push(operationId(identity, rootId, prefix + call.id));
      await walk(subRunId(runId, call.id), prefix + subPrefix(call.id));
    }
  };
  await walk(rootId, "");
  return tree;
}
export type RememberScope = "run" | "conversation";
export const unknownOutcome =
  "Action outcome unknown; it may or may not have been applied. Do not retry automatically.";
export const undeliveredOutcome =
  "Action request was not delivered; no change was made.";
export class ActionConflict extends Error {
  constructor() {
    super("Action decision conflict");
  }
}
const grantKey = (
  identity: Identity,
  scope: RememberScope,
  runId: string,
  tool: string,
  toolVersion: string,
  args: unknown,
) =>
  JSON.stringify([
    "grant",
    identity.tenantId,
    identity.actorId,
    scope,
    scope === "run" ? runId : conversationOf(runId),
    tool,
    toolVersion,
    createHash("sha256").update(JSON.stringify(args)).digest("hex"),
  ]);
export async function eraseGrants(
  records: ReturnType<typeof recordStore>,
  identity: Identity,
  conversationId: string,
) {
  const scopeKey = grantKey(
    identity,
    "conversation",
    conversationId,
    "",
    "",
    0,
  );
  for (let after = ""; ;) {
    const rows = await records.scan("grant", after, 100, undefined, scopeKey);
    for (const row of rows)
      await records.remove(z.object({ key: z.string() }).parse(row.value).key);
    if (rows.length < 100) return;
    after = rows[rows.length - 1]?.id ?? "";
  }
}
export interface ActionStore {
  load(identity: Identity, id: string): Promise<Action | undefined>;
  propose(identity: Identity, action: Action): Promise<Action>;
  decide(
    identity: Identity,
    id: string,
    approved: boolean,
    content?: Record<string, unknown>,
  ): Promise<Action>;
  begin(
    identity: Identity,
    id: string,
    ownership?: RunOwnership,
  ): Promise<boolean>;
  receipt(identity: Identity, id: string, receipt: string): Promise<void>;
  unknown(identity: Identity, id: string): Promise<void>;
  undelivered(identity: Identity, id: string): Promise<void>;
  remember(
    identity: Identity,
    action: Action,
    scope: RememberScope,
  ): Promise<void>;
  remembered(
    identity: Identity,
    runId: string,
    tool: string,
    toolVersion: string,
    args: unknown,
  ): Promise<boolean>;
}
export function createActionStore(
  records: ReturnType<typeof recordStore>,
): ActionStore {
  const key = (identity: Identity, id: string) =>
    JSON.stringify(["action", identity.tenantId, identity.actorId, id]);
  return {
    async load(identity, id) {
      const record = await records.read(key(identity, id));
      return record ? actionSchema.parse(record.value) : undefined;
    },
    propose: (identity, action) =>
      records.mutate(key(identity, action.id), (value) => {
        const state =
          value === undefined
            ? actionSchema.parse(action)
            : actionSchema.parse(value);
        if (
          state.runId !== action.runId ||
          state.callId !== action.callId ||
          state.tool !== action.tool ||
          state.toolVersion !== action.toolVersion ||
          JSON.stringify(state.args) !== JSON.stringify(action.args)
        )
          throw new Error("Action mismatch");
        return { value: state, result: state };
      }),
    decide: (identity, id, approved, content) =>
      records.mutate(key(identity, id), (value) => {
        const state = actionSchema.parse(value);
        if (state.status === "pending") {
          state.status =
            state.expiresAt <= Date.now()
              ? "expired"
              : approved
                ? "approved"
                : "declined";
          if (state.status === "approved" && content) state.content = content;
        } else if (state.status !== (approved ? "approved" : "declined"))
          throw new ActionConflict();
        return { value: state, result: state };
      }),
    begin: (identity, id, ownership) => {
      const change = (value: unknown) => {
        const state = actionSchema.parse(value);
        if (ownership && state.runId !== ownership.runId)
          throw new RunLeaseError();
        if (state.status !== "approved") return { value: state, result: false };
        if (state.expiresAt <= Date.now()) {
          state.status = "expired";
          return { value: state, result: false };
        }
        state.status = "executing";
        return { value: state, result: true };
      };
      if (!ownership) return records.mutate(key(identity, id), change);
      return withRunLease(
        records,
        identity,
        ownership,
        async (tx, assertOwned) => {
          const actionKey = key(identity, id);
          const action = await tx.read(actionKey);
          const next = change(action?.value);
          assertOwned();
          await tx.write(actionKey, next.value, action?.revision ?? 0);
          return next.result;
        },
      );
    },
    async receipt(identity, id, receipt) {
      await records.mutate(key(identity, id), (value) => {
        const state = actionSchema.parse(value);
        if (state.status !== "executing" && state.status !== "completed")
          throw new Error("Action not executing");
        if (state.receipt !== undefined && state.receipt !== receipt)
          throw new Error("Receipt conflict");
        state.receipt = z.string().max(32_000).parse(receipt);
        state.status = "completed";
        return { value: state, result: undefined };
      });
    },
    async unknown(identity, id) {
      await records.mutate(key(identity, id), (value) => {
        const state = actionSchema.parse(value);
        if (state.status === "executing") {
          state.status = "unknown";
          state.receipt = unknownOutcome;
        } else if (state.status !== "unknown")
          throw new Error("Action not executing");
        return { value: state, result: undefined };
      });
    },
    async undelivered(identity, id) {
      await records.mutate(key(identity, id), (value) => {
        const state = actionSchema.parse(value);
        if (state.status !== "executing")
          throw new Error("Action not executing");
        state.status = "undelivered";
        state.receipt = undeliveredOutcome;
        return { value: state, result: undefined };
      });
    },
    async remember(identity, action, scope) {
      if (action.status !== "approved")
        throw new Error("Only approved actions can be remembered");
      const grant = grantKey(
        identity,
        scope,
        action.runId,
        action.tool,
        action.toolVersion,
        action.args,
      );
      await records.mutate(grant, () => ({
        value: {
          key: grant,
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          conversationId: conversationOf(action.runId),
        },
        result: undefined,
      }));
    },
    async remembered(identity, runId, tool, toolVersion, args) {
      for (const scope of ["run", "conversation"] as const)
        if (
          await records.read(
            grantKey(identity, scope, runId, tool, toolVersion, args),
          )
        )
          return true;
      return false;
    },
  };
}
