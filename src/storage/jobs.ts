import { z } from "zod";
import type { Identity, TerminalResult, Turn } from "../core/contracts.js";
import {
  isActivity,
  isTerminal,
  jobInputSchema,
  jobSchema,
  maxSteering,
  type JobInput,
  type SteeringInput,
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
export const conversationStateSchema = z.object({
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
  resume(
    identity: Identity,
    conversationId: string,
    id: string,
    approvalId: string,
  ): Promise<boolean>;
  steer(
    identity: Identity,
    conversationId: string,
    id: string,
    message: SteeringInput,
  ): Promise<Job>;
  consumeSteering(
    identity: Identity,
    conversationId: string,
    id: string,
    ids: readonly string[],
    lease: RunOwnership,
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
      ? conversationStateSchema.parse({
          identity,
          id,
          messages: value ?? [],
          jobs: [],
        })
      : conversationStateSchema.parse(value);
  const jobIn = (
    value: unknown,
    identity: Identity,
    conversationId: string,
    id: string,
  ) => {
    const state = stateFrom(value, identity, conversationId);
    const job = state.jobs.find((item) => item.id === id);
    if (!job) throw new Error("Run not found");
    return { state, job };
  };
  const hasActive = (value: unknown) =>
    !Array.isArray(value) &&
    value !== undefined &&
    conversationStateSchema
      .parse(value)
      .jobs.some((job) => !isTerminal(job.status));
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
  const untrack = (key: string) =>
    records
      .transact(async (tx) => {
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
      })
      .catch((error: unknown) => {
        if (!(error instanceof StorageConflict)) throw error;
      });
  async function backfill() {
    const keys: string[] = [];
    for (let after = ""; ;) {
      const rows = await records.scan("conversation", after);
      if (!rows.length) break;
      after = rows[rows.length - 1]?.id ?? "";
      for (const row of rows)
        if (hasActive(row.value)) {
          const state = conversationStateSchema.parse(row.value);
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
  const mutateJob = (
    identity: Identity,
    conversationId: string,
    id: string,
    lease: RunOwnership | undefined,
    change: (value: unknown) => { value: unknown; result: Job },
  ) => {
    const key = conversationKey(identity, conversationId);
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
  const apply: JobStore["update"] = (
    identity,
    conversationId,
    id,
    event,
    outcome,
    lease,
    turns,
  ) =>
    mutateJob(identity, conversationId, id, lease, (value) => {
      const { state, job } = jobIn(value, identity, conversationId, id);
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
    });
  return {
    submit: async (identity, conversationId, input) => {
      const parsed = jobInputSchema.parse(input);
      const key = conversationKey(identity, conversationId);
      return records.transact(async (tx) => {
        const record = await tx.read(key);
        const state = stateFrom(record?.value, identity, conversationId);
        if (state.deleted) throw new Error("Conversation erased");
        if (state.retiredRuns.includes(parsed.id)) throw new JobConflict();
        const existing = state.jobs.find((job) => job.id === parsed.id);
        if (existing) {
          if (
            JSON.stringify(existing.input) !== JSON.stringify(parsed.input) ||
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
          steering: [],
          events: [],
        };
        append(job, { type: "queued" });
        state.jobs.push(job);
        await tx.write(key, state, record?.revision ?? 0);
        await enqueue(tx, key);
        return job;
      });
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
    steer: (identity, conversationId, id, message) =>
      records.mutate(conversationKey(identity, conversationId), (value) => {
        const { state, job } = jobIn(value, identity, conversationId, id);
        const existing = job.steering.find((item) => item.id === message.id);
        if (existing) {
          if (JSON.stringify(existing.input) !== JSON.stringify(message.input))
            throw new JobConflict();
        } else {
          if (isTerminal(job.status) || job.steering.length >= maxSteering)
            throw new JobConflict();
          job.steering.push({ ...message, consumed: false });
          append(job, { type: "steering_received" });
        }
        return { value: state, result: job };
      }),
    consumeSteering: (identity, conversationId, id, ids, lease) =>
      mutateJob(identity, conversationId, id, lease, (value) => {
        const { state, job } = jobIn(value, identity, conversationId, id);
        for (const item of job.steering)
          if (ids.includes(item.id)) item.consumed = true;
        return { value: state, result: job };
      }),
    retry: (identity, conversationId, id) =>
      records.mutate(conversationKey(identity, conversationId), (value) => {
        const { state, job } = jobIn(value, identity, conversationId, id);
        if (!isTerminal(job.status)) {
          job.attempts += 1;
          job.availableAt =
            Date.now() +
            Math.min(2 ** job.attempts * 1000, 60_000) *
              (0.5 + Math.random() / 2);
        }
        return { value: state, result: job };
      }),
    resume: (identity, conversationId, id, approvalId) =>
      records.mutate(conversationKey(identity, conversationId), (value) => {
        const { state, job } = jobIn(value, identity, conversationId, id);
        const waiting =
          job.status === "awaiting_approval" &&
          job.events
            .filter((event) => event.type === "awaiting_approval")
            .at(-1)?.approvalId === approvalId;
        if (waiting) append(job, { type: "queued" });
        return { value: state, result: waiting };
      }),
    async cancel(identity, conversationId, id) {
      await records.mutate(
        conversationKey(identity, conversationId),
        (value) => {
          const { state, job } = jobIn(value, identity, conversationId, id);
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
        const state = conversationStateSchema.parse(record?.value);
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
        cursor: keys.length < 100 ? "" : (keys.at(-1) ?? ""),
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
