import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import { HttpError } from "../service/contracts.js";
import { isTerminal } from "../service/terminal.js";
import { conversationStateSchema } from "./jobs.js";
import { conversationKey, retiredKey } from "./conversations.js";
import { actionSchema, eraseGrants, runTree } from "./actions.js";
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
  const retiredKeys = async (identity: Identity, id: string) => {
    const keys: string[] = [];
    for (let after = ""; ;) {
      const rows = await records.scan(
        "retired",
        after,
        100,
        undefined,
        retiredKey(identity, id, ""),
      );
      for (const row of rows)
        keys.push(z.object({ key: z.string() }).parse(row.value).key);
      if (rows.length < 100) return keys;
      after = rows[rows.length - 1]?.id ?? "";
    }
  };
  const runsFrom = (
    state: z.infer<typeof stateSchema>,
    id: string,
    keys: readonly string[],
  ) => [
    ...state.purgeRuns,
    ...[
      ...state.retiredRuns,
      ...keys.map((key) => z.array(z.string()).parse(JSON.parse(key)).at(-1)),
    ].map((runId) => JSON.stringify([id, runId])),
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
        throw new HttpError(409, "Resolve unfinished actions before erasure");
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
        throw new HttpError(
          409,
          "Cancel or resolve unfinished runs before erasure",
        );
      const tombstones = await retiredKeys(identity, id);
      const runIds = runsFrom(current, id, tombstones);
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
      for (const tombstone of tombstones) await records.remove(tombstone);
      await eraseGrants(records, identity, id);
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
