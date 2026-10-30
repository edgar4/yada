import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import { isTerminal, jobSchema } from "../service/contracts.js";
import { conversationKey } from "./conversations.js";
import { operationId } from "./actions.js";
import type { recordStore } from "./records.js";
import { checkpointSchema } from "../core/checkpoint.js";
export function createRetention(records: ReturnType<typeof recordStore>) {
  return {
    async eraseConversation(identity: Identity, id: string) {
      const key = conversationKey(identity, id);
      const runIds = await records.mutate(key, (value) => {
        const current = z
          .object({
            jobs: z.array(jobSchema).default([]),
            purgeRuns: z.array(z.string()).default([]),
            retiredRuns: z.array(z.string()).default([]),
          })
          .parse(Array.isArray(value) || value === undefined ? {} : value);
        if (current.jobs.some((job) => !isTerminal(job.status)))
          throw new Error("Cancel or resolve unfinished runs before erasure");
        const runIds = [
          ...current.purgeRuns,
          ...current.retiredRuns.map((runId) => JSON.stringify([id, runId])),
          ...current.jobs.map((job) => JSON.stringify([id, job.id])),
        ];
        return {
          value: {
            identity,
            id,
            messages: [],
            jobs: [],
            deleted: true,
            purgeRuns: runIds,
          },
          result: runIds,
        };
      });
      for (const runId of runIds) {
        const runKey = JSON.stringify([
          "run",
          identity.tenantId,
          identity.actorId,
          runId,
        ]);
        const run = await records.read(runKey);
        if (run) {
          const state = z
            .object({ checkpoint: checkpointSchema.optional() })
            .parse(run.value);
          const calls =
            state.checkpoint?.messages.flatMap((turn) =>
              turn.role === "assistant" ? turn.toolCalls : [],
            ) ?? [];
          for (const call of calls)
            await records.remove(
              JSON.stringify([
                "action",
                identity.tenantId,
                identity.actorId,
                operationId(identity, runId, call.id),
              ]),
            );
        }
        await records.remove(runKey);
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
