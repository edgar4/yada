import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import { isTerminal, jobSchema } from "../service/contracts.js";
import { conversationKey } from "./conversations.js";
import { actionSchema, operationId } from "./actions.js";
import type { recordStore } from "./records.js";
import { checkpointSchema } from "../core/checkpoint.js";
export function createRetention(records: ReturnType<typeof recordStore>) {
  const stateSchema = z.object({
    jobs: z.array(jobSchema).default([]),
    purgeRuns: z.array(z.string()).default([]),
    retiredRuns: z.array(z.string()).default([]),
  });
  const stateFrom = (value: unknown) =>
    stateSchema.parse(Array.isArray(value) || value === undefined ? {} : value);
  const runsFrom = (state: z.infer<typeof stateSchema>, id: string) => [
    ...state.purgeRuns,
    ...state.retiredRuns.map((runId) => JSON.stringify([id, runId])),
    ...state.jobs.map((job) => JSON.stringify([id, job.id])),
  ];
  const runKey = (identity: Identity, runId: string) =>
    JSON.stringify(["run", identity.tenantId, identity.actorId, runId]);
  async function resolvedActions(identity: Identity, runId: string) {
    const run = await records.read(runKey(identity, runId));
    const state = z
      .object({ checkpoint: checkpointSchema.optional() })
      .parse(run?.value ?? {});
    const keys =
      state.checkpoint?.messages
        .flatMap((turn) => (turn.role === "assistant" ? turn.toolCalls : []))
        .map((call) =>
          JSON.stringify([
            "action",
            identity.tenantId,
            identity.actorId,
            operationId(identity, runId, call.id),
          ]),
        ) ?? [];
    for (const key of keys) {
      const action = await records.read(key);
      if (action && actionSchema.parse(action.value).status === "executing")
        throw new Error("Resolve unfinished actions before erasure");
    }
    return keys;
  }
  return {
    async eraseConversation(identity: Identity, id: string) {
      const key = conversationKey(identity, id);
      const planned = await records.read(key);
      const current = stateFrom(planned?.value);
      if (current.jobs.some((job) => !isTerminal(job.status)))
        throw new Error("Cancel or resolve unfinished runs before erasure");
      const runIds = runsFrom(current, id);
      for (const runId of runIds) await resolvedActions(identity, runId);
      await records.write(
        key,
        {
          identity,
          id,
          messages: [],
          jobs: [],
          deleted: true,
          purgeRuns: runIds,
        },
        planned?.revision ?? 0,
      );
      for (const runId of runIds) {
        for (const actionKey of await resolvedActions(identity, runId))
          await records.remove(actionKey);
        await records.remove(runKey(identity, runId));
      }
      await records.mutate(key, (value) => ({
        value: {
          ...z.record(z.string(), z.unknown()).parse(value),
          purgeRuns: [],
        },
        result: undefined,
      }));
    },
  };
}
