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
  withSummary,
  type ConversationSummary,
} from "./conversations.js";
import type { recordStore } from "./records.js";
import { withRunLease, RunLeaseError, type RunOwnership } from "./runs.js";
const storedJobSchema = jobSchema.omit({ history: true }).extend({
  history: jobSchema.shape.history.optional(),
  historyLength: z.number().int().nonnegative().optional(),
});
type StoredJob = z.infer<typeof storedJobSchema>;
const keptTerminalJobs = 20;
export const conversationStateSchema = z.object({
  identity: identitySchema,
  id: z.string(),
  messages: z.array(messageSchema),
  deleted: z.boolean().default(false),
  retiredRuns: z.array(z.string()).default([]),
  purgeRuns: z.array(z.string()).default([]),
  jobs: z.array(storedJobSchema),
});
type ConversationState = z.infer<typeof conversationStateSchema>;
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
    summary?: ConversationSummary,
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
  retry(
    identity: Identity,
    conversationId: string,
    id: string,
    lease?: RunOwnership,
  ): Promise<Job>;
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
  const view = (state: ConversationState, job: StoredJob): Job => {
    const { historyLength = 0, ...rest } = job;
    return {
      ...rest,
      history: job.history ?? state.messages.slice(0, historyLength),
    };
  };
  const finish = <T>(state: ConversationState, result: T) => ({
    value: state,
    result,
    active: state.jobs.some((job) => !isTerminal(job.status)),
  });
  const append = (
    job: StoredJob,
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
    change: (value: unknown) => {
      value: unknown;
      result: Job;
      active: boolean;
    },
  ) => {
    const key = conversationKey(identity, conversationId);
    if (!lease) return records.mutate(key, change);
    if (lease.runId !== JSON.stringify([conversationId, id]))
      return Promise.reject(new RunLeaseError());
    return withRunLease(records, identity, lease, async (tx, assertOwned) => {
      const conversation = await tx.read(key);
      const next = change(conversation?.value);
      assertOwned();
      await tx.write(key, next.value, conversation?.revision ?? 0, next.active);
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
    summary,
  ) =>
    mutateJob(identity, conversationId, id, lease, (value) => {
      const { state, job } = jobIn(value, identity, conversationId, id);
      if (isTerminal(job.status)) return finish(state, view(state, job));
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
        if (summary)
          for (const item of state.jobs)
            item.history ??= state.messages.slice(0, item.historyLength ?? 0);
        state.messages = [...withSummary(state.messages, summary), ...added];
        for (const old of state.jobs
          .filter((item) => isTerminal(item.status))
          .slice(0, -keptTerminalJobs)) {
          old.events = [];
          old.steering = [];
          old.history = [];
        }
      }
      return finish(state, view(state, job));
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
          return view(state, existing);
        }
        if (state.jobs.some((job) => !isTerminal(job.status)))
          throw new JobConflict();
        const job: StoredJob = {
          ...parsed,
          availableAt: 0,
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "queued",
          cancelRequested: false,
          historyLength: state.messages.length,
          steering: [],
          events: [],
        };
        append(job, { type: "queued" });
        state.jobs.push(job);
        await tx.write(key, state, record?.revision ?? 0, true);
        return view(state, job);
      });
    },
    async load(identity, conversationId, id) {
      const record = await records.read(
        conversationKey(identity, conversationId),
      );
      return record
        ? (() => {
            const state = stateFrom(record.value, identity, conversationId);
            const job = state.jobs.find((item) => item.id === id);
            return job && view(state, job);
          })()
        : undefined;
    },
    update: apply,
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
        return finish(state, view(state, job));
      }),
    consumeSteering: (identity, conversationId, id, ids, lease) =>
      mutateJob(identity, conversationId, id, lease, (value) => {
        const { state, job } = jobIn(value, identity, conversationId, id);
        for (const item of job.steering)
          if (ids.includes(item.id)) item.consumed = true;
        return finish(state, view(state, job));
      }),
    retry: (identity, conversationId, id, lease) =>
      mutateJob(identity, conversationId, id, lease, (value) => {
        const { state, job } = jobIn(value, identity, conversationId, id);
        if (!isTerminal(job.status)) {
          job.attempts += 1;
          job.availableAt =
            Date.now() +
            Math.min(2 ** job.attempts * 1000, 60_000) *
              (0.5 + Math.random() / 2);
        }
        return finish(state, view(state, job));
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
        return finish(state, waiting);
      }),
    async cancel(identity, conversationId, id) {
      await records.mutate(
        conversationKey(identity, conversationId),
        (value) => {
          const { state, job } = jobIn(value, identity, conversationId, id);
          if (!isTerminal(job.status)) job.cancelRequested = true;
          return finish(state, undefined);
        },
      );
    },
    async pending(after = "") {
      const rows = await records.scan("conversation", after, 100, true);
      const jobs: {
        identity: Identity;
        conversationId: string;
        job: Job;
      }[] = [];
      for (const row of rows) {
        const state = conversationStateSchema.parse(row.value);
        for (const job of state.jobs)
          if (
            !isTerminal(job.status) &&
            (job.availableAt <= Date.now() || job.cancelRequested)
          )
            jobs.push({
              identity: state.identity,
              conversationId: state.id,
              job: view(state, job),
            });
      }
      return {
        cursor: rows.length < 100 ? "" : (rows.at(-1)?.id ?? ""),
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
        return finish(
          state,
          removed.map((job) => job.id),
        );
      }),
  };
}
