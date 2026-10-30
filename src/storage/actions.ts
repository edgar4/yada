import { createHash } from "node:crypto";
import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import type { recordStore } from "./records.js";
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
  ]),
  receipt: z.string().max(32_000).optional(),
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
export interface ActionStore {
  load(identity: Identity, id: string): Promise<Action | undefined>;
  propose(identity: Identity, action: Action): Promise<Action>;
  decide(identity: Identity, id: string, approved: boolean): Promise<Action>;
  begin(identity: Identity, id: string): Promise<boolean>;
  receipt(identity: Identity, id: string, receipt: string): Promise<void>;
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
    decide: (identity, id, approved) =>
      records.mutate(key(identity, id), (value) => {
        const state = actionSchema.parse(value);
        if (state.status === "pending")
          state.status =
            state.expiresAt <= Date.now()
              ? "expired"
              : approved
                ? "approved"
                : "declined";
        else if (state.status !== (approved ? "approved" : "declined"))
          throw new Error("Action decision conflict");
        return { value: state, result: state };
      }),
    begin: (identity, id) =>
      records.mutate(key(identity, id), (value) => {
        const state = actionSchema.parse(value);
        if (state.status !== "approved") return { value: state, result: false };
        if (state.expiresAt <= Date.now()) {
          state.status = "expired";
          return { value: state, result: false };
        }
        state.status = "executing";
        return { value: state, result: true };
      }),
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
  };
}
