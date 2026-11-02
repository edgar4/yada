import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import { isTerminal } from "../service/contracts.js";
import { conversationStateSchema } from "./jobs.js";
import { conversationKey } from "./conversations.js";
import { actionSchema, runTree } from "./actions.js";
import type { recordStore } from "./records.js";
import { memoryKey } from "./memory.js";
import { createRunStore } from "./runs.js";
export function createRetention(records: ReturnType<typeof recordStore>) {
  const stateSchema = conversationStateSchema.pick({
    jobs: true,
    purgeRuns: true,
    retiredRuns: true,
  });
  const stateFrom = (value: unknown) =>
    stateSchema.parse({
      jobs: [],
      ...(Array.isArray(value) || value === undefined ? {} : value),
    });
  const runsFrom = (state: z.infer<typeof stateSchema>, id: string) => [
    ...state.purgeRuns,
    ...state.retiredRuns.map((runId) => JSON.stringify([id, runId])),
    ...state.jobs.map((job) => JSON.stringify([id, job.id])),
  ];
  const runKey = (identity: Identity, runId: string) =>
    JSON.stringify(["run", identity.tenantId, identity.actorId, runId]);
  const runs = createRunStore(records);
  async function resolvedActions(identity: Identity, runId: string) {
    const tree = await runTree(runs, identity, runId);
    const keys = tree.actionIds.map((id) =>
      JSON.stringify(["action", identity.tenantId, identity.actorId, id]),
    );
    for (const key of keys) {
      const action = await records.read(key);
      if (action && actionSchema.parse(action.value).status === "executing")
        throw new Error("Resolve unfinished actions before erasure");
    }
    return { keys, runIds: tree.runIds };
  }
  return {
    eraseActorMemory: (identity: Identity) =>
      records.remove(memoryKey(identity)),
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
        const tree = await resolvedActions(identity, runId);
        for (const actionKey of tree.keys) await records.remove(actionKey);
        for (const id of tree.runIds)
          await records.remove(runKey(identity, id));
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
