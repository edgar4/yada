import { z } from "zod";
import type { Identity, TerminalResult, Turn } from "../core/contracts.js";
import {
  isActivity,
  isTerminal,
  jobInputSchema,
  jobSchema,
  type JobInput,
  type Job,
  type RunEvent,
} from "../service/contracts.js";
import {
  conversationKey,
  identitySchema,
  messageSchema,
  type ConversationMessage,
} from "./conversations.js";
import { StorageConflict, type recordStore } from "./records.js";
import { withRunLease, RunLeaseError, type RunOwnership } from "./runs.js";
const stateSchema = z.object({
  identity: identitySchema,
  id: z.string(),
  messages: z.array(messageSchema),
  deleted: z.boolean().default(false),
  retiredRuns: z.array(z.string()).default([]),
  purgeRuns: z.array(z.string()).default([]),
  jobs: z.array(jobSchema),
});
const queueKey = JSON.stringify(["job_queue"]);
const queueSchema = z.object({
  complete: z.boolean(),
  keys: z.array(z.string()),
});
export class JobConflict extends Error {
  constructor() {
    super(
      "Conversation has an active run or request conflicts with an existing run",
    );
  }
}
export interface JobStore {
  submit(
    identity: Identity,
    conversationId: string,
    input: JobInput,
  ): Promise<Job>;
  load(
    identity: Identity,
    conversationId: string,
    id: string,
  ): Promise<Job | undefined>;
  update(
    identity: Identity,
    conversationId: string,
    id: string,
    event: Omit<RunEvent, "version" | "sequence" | "at">,
    outcome?: TerminalResult,
    lease?: RunOwnership,
    turns?: readonly Turn[],
  ): Promise<Job>;
  retry(identity: Identity, conversationId: string, id: string): Promise<Job>;
  cancel(identity: Identity, conversationId: string, id: string): Promise<void>;
  pending(after?: string): Promise<{
    cursor: string;
    jobs: { identity: Identity; conversationId: string; job: Job }[];
  }>;
  prune(
    identity: Identity,
    conversationId: string,
    before: number,
  ): Promise<string[]>;
}
export function createJobStore(
  records: ReturnType<typeof recordStore>,
): JobStore {
  const stateFrom = (value: unknown, identity: Identity, id: string) =>
    value === undefined || Array.isArray(value)
      ? stateSchema.parse({ identity, id, messages: value ?? [], jobs: [] })
      : stateSchema.parse(value);
  const hasActive = (value: unknown) =>
    !Array.isArray(value) &&
    value !== undefined &&
    stateSchema.parse(value).jobs.some((job) => !isTerminal(job.status));
  async function enqueue(tx: ReturnType<typeof recordStore>, key: string) {
    const row = await tx.read(queueKey);
    const queue = row
      ? queueSchema.parse(row.value)
      : { complete: false, keys: [] };
    if (queue.keys.includes(key)) return;
    await tx.write(
      queueKey,
      { ...queue, keys: [...queue.keys, key] },
      row?.revision ?? 0,
    );
  }
  async function untrack(key: string) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await records.transaction(async (tx) => {
          const row = await tx.read(queueKey);
          if (!row) return;
          const queue = queueSchema.parse(row.value);
          if (!queue.keys.includes(key)) return;
          if (hasActive((await tx.read(key))?.value)) return;
          await tx.write(
            queueKey,
            { ...queue, keys: queue.keys.filter((item) => item !== key) },
            row.revision,
          );
        });
        return;
      } catch (error) {
        if (!(error instanceof StorageConflict)) throw error;
      }
    }
  }
  async function backfill() {
    const keys: string[] = [];
    for (let after = ""; ;) {
      const rows = await records.scan("conversation", after);
      if (!rows.length) break;
      after = rows[rows.length - 1]?.id ?? "";
      for (const row of rows)
        if (hasActive(row.value)) {
          const state = stateSchema.parse(row.value);
          keys.push(conversationKey(state.identity, state.id));
        }
    }
    await records.mutate(queueKey, (value) => {
      const queue = value ? queueSchema.parse(value) : { keys: [] };
      return {
        value: { complete: true, keys: [...new Set([...queue.keys, ...keys])] },
        result: undefined,
      };
    });
  }
  const append = (
    job: Job,
    event: Omit<RunEvent, "version" | "sequence" | "at">,
  ) => {
    const previous = job.events.at(-1);
    const activity = isActivity(event.type);
    job.updatedAt = Date.now();
    if (!activity) {
      job.status = event.type as Job["status"];
      job.availableAt =
        event.type === "awaiting_approval"
          ? (event.expiresAt ?? Date.now() + 600_000)
          : Date.now() + (event.type === "reconciling" ? 5000 : 0);
    }
    if (
      !activity &&
      previous?.type === event.type &&
      previous.approvalId === event.approvalId &&
      previous.text === event.text &&
      previous.code === event.code
    )
      return;
    if (
      job.events.length >= 1000 &&
      !isTerminal(event.type) &&
      event.type !== "awaiting_approval" &&
      !(
        event.approvalId &&
        !job.events.some((item) => item.approvalId === event.approvalId)
      )
    )
      return;
    job.events.push({
      ...event,
      version: 1,
      sequence: job.events.length + 1,
      at: job.updatedAt,
    });
  };
  const apply: JobStore["update"] = (
    identity,
    conversationId,
    id,
    event,
    outcome,
    lease,
    turns,
  ) => {
    const key = conversationKey(identity, conversationId);
    const change = (value: unknown) => {
      const state = stateFrom(value, identity, conversationId);
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error("Run not found");
      if (isTerminal(job.status)) return { value: state, result: job };
      append(job, event);
      if (outcome) {
        if (outcome.status !== event.type)
          throw new Error("Outcome status mismatch");
        job.outcome = outcome;
        const added: ConversationMessage[] =
          outcome.status === "completed"
            ? turns
              ? [...turns]
              : [
                  { role: "user", content: job.input },
                  { role: "assistant", content: outcome.text, toolCalls: [] },
                ]
            : [
                { role: "user", content: job.input },
                {
                  role: "failure",
                  code:
                    outcome.status === "failed" ? outcome.code : "cancelled",
                },
              ];
        state.messages.push(...added);
      }
      return { value: state, result: job };
    };
    if (!lease) return records.mutate(key, change);
    if (lease.runId !== JSON.stringify([conversationId, id]))
      return Promise.reject(new RunLeaseError());
    return withRunLease(records, identity, lease, async (tx, assertOwned) => {
      const conversation = await tx.read(key);
      const next = change(conversation?.value);
      assertOwned();
      await tx.write(key, next.value, conversation?.revision ?? 0);
      return next.result;
    });
  };
  return {
    submit: async (identity, conversationId, input) => {
      const parsed = jobInputSchema.parse(input);
      const key = conversationKey(identity, conversationId);
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          return await records.transaction(async (tx) => {
            const record = await tx.read(key);
            const state = stateFrom(record?.value, identity, conversationId);
            if (state.deleted) throw new Error("Conversation erased");
            if (state.retiredRuns.includes(parsed.id)) throw new JobConflict();
            const existing = state.jobs.find((job) => job.id === parsed.id);
            if (existing) {
              if (
                JSON.stringify(existing.input) !==
                  JSON.stringify(parsed.input) ||
                existing.profileId !== parsed.profileId
              )
                throw new JobConflict();
              if (!isTerminal(existing.status)) await enqueue(tx, key);
              return existing;
            }
            if (state.jobs.some((job) => !isTerminal(job.status)))
              throw new JobConflict();
            const job: Job = {
              ...parsed,
              availableAt: 0,
              attempts: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              status: "queued",
              cancelRequested: false,
              history: state.messages,
              events: [],
            };
            append(job, { type: "queued" });
            state.jobs.push(job);
            await tx.write(key, state, record?.revision ?? 0);
            await enqueue(tx, key);
            return job;
          });
        } catch (error) {
          if (!(error instanceof StorageConflict)) throw error;
        }
      }
      throw new StorageConflict();
    },
    async load(identity, conversationId, id) {
      const record = await records.read(
        conversationKey(identity, conversationId),
      );
      return record
        ? stateFrom(record.value, identity, conversationId).jobs.find(
            (job) => job.id === id,
          )
        : undefined;
    },
    update: async (
      identity,
      conversationId,
      id,
      event,
      outcome,
      lease,
      turns,
    ) => {
      const job = await apply(
        identity,
        conversationId,
        id,
        event,
        outcome,
        lease,
        turns,
      );
      if (isTerminal(job.status))
        await untrack(conversationKey(identity, conversationId)).catch(
          () => undefined,
        );
      return job;
    },
    retry: (identity, conversationId, id) =>
      records.mutate(conversationKey(identity, conversationId), (value) => {
        const state = stateFrom(value, identity, conversationId);
        const job = state.jobs.find((item) => item.id === id);
        if (!job) throw new Error("Run not found");
        if (!isTerminal(job.status)) {
          job.attempts += 1;
          job.availableAt =
            Date.now() +
            Math.min(2 ** job.attempts * 1000, 60_000) *
              (0.5 + Math.random() / 2);
        }
        return { value: state, result: job };
      }),
    async cancel(identity, conversationId, id) {
      await records.mutate(
        conversationKey(identity, conversationId),
        (value) => {
          const state = stateFrom(value, identity, conversationId);
          const job = state.jobs.find((item) => item.id === id);
          if (!job) throw new Error("Run not found");
          if (!isTerminal(job.status)) job.cancelRequested = true;
          return { value: state, result: undefined };
        },
      );
    },
    async pending(after = "") {
      let row = await records.read(queueKey);
      if (!row || !queueSchema.parse(row.value).complete) {
        await backfill();
        row = await records.read(queueKey);
      }
      const keys = queueSchema
        .parse(row?.value)
        .keys.filter((key) => key > after)
        .sort()
        .slice(0, 100);
      const jobs: {
        identity: Identity;
        conversationId: string;
        job: Job;
      }[] = [];
      for (const key of keys) {
        const record = await records.read(key);
        if (!hasActive(record?.value)) {
          await untrack(key);
          continue;
        }
        const state = stateSchema.parse(record?.value);
        for (const job of state.jobs)
          if (
            !isTerminal(job.status) &&
            (job.availableAt <= Date.now() || job.cancelRequested)
          )
            jobs.push({
              identity: state.identity,
              conversationId: state.id,
              job,
            });
      }
      return {
        cursor: keys.at(-1) ?? "",
        jobs,
      };
    },
    prune: (identity, conversationId, before) =>
      records.mutate(conversationKey(identity, conversationId), (value) => {
        const state = stateFrom(value, identity, conversationId);
        const removed = state.jobs.filter(
          (job) => isTerminal(job.status) && job.updatedAt < before,
        );
        state.jobs = state.jobs.filter((job) => !removed.includes(job));
        state.retiredRuns.push(...removed.map((job) => job.id));
        return { value: state, result: removed.map((job) => job.id) };
      }),
  };
}
