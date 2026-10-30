import { z } from "zod";
import type { Identity, TerminalResult } from "../core/contracts.js";
import {
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
} from "./conversations.js";
import type { recordStore } from "./records.js";
const stateSchema = z.object({
  identity: identitySchema,
  id: z.string(),
  messages: z.array(messageSchema),
  jobs: z.array(jobSchema),
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
      ? stateSchema.parse({ identity, id, messages: value ?? [], jobs: [] })
      : stateSchema.parse(value);
  const append = (
    job: Job,
    event: Omit<RunEvent, "version" | "sequence" | "at">,
  ) => {
    if (job.events.length >= 1000) throw new Error("Run event limit exceeded");
    job.updatedAt = Date.now();
    job.status = event.type;
    job.availableAt =
      Date.now() +
      (event.type === "awaiting_approval"
        ? 600_000
        : event.type === "reconciling"
          ? 5000
          : 0);
    job.events.push({
      ...event,
      version: 1,
      sequence: job.events.length + 1,
      at: job.updatedAt,
    });
  };
  return {
    submit: (identity, conversationId, input) => {
      const parsed = jobInputSchema.parse(input);
      return records.mutate(
        conversationKey(identity, conversationId),
        (value) => {
          const state = stateFrom(value, identity, conversationId);
          const existing = state.jobs.find((job) => job.id === parsed.id);
          if (existing) {
            if (
              existing.input !== parsed.input ||
              existing.profileId !== parsed.profileId
            )
              throw new JobConflict();
            return { value: state, result: existing };
          }
          if (state.jobs.some((job) => !isTerminal(job.status)))
            throw new JobConflict();
          const job: Job = {
            ...parsed,
            availableAt: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: "queued",
            cancelRequested: false,
            history: state.messages,
            events: [],
          };
          append(job, { type: "queued" });
          state.jobs.push(job);
          return { value: state, result: job };
        },
      );
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
    update: (identity, conversationId, id, event, outcome) =>
      records.mutate(conversationKey(identity, conversationId), (value) => {
        const state = stateFrom(value, identity, conversationId);
        const job = state.jobs.find((item) => item.id === id);
        if (!job) throw new Error("Run not found");
        if (isTerminal(job.status)) return { value: state, result: job };
        append(job, event);
        if (outcome) {
          if (outcome.status !== event.type)
            throw new Error("Outcome status mismatch");
          job.outcome = outcome;
          if (outcome.status === "completed")
            state.messages.push(
              { role: "user", content: job.input },
              { role: "assistant", content: outcome.text },
            );
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
      const rows = await records.scan("conversation", after);
      return {
        cursor: rows.at(-1)?.id ?? "",
        jobs: rows.flatMap((row) => {
          if (Array.isArray(row.value)) return [];
          const state = stateSchema.parse(row.value);
          return state.jobs
            .filter(
              (job) =>
                !isTerminal(job.status) &&
                (job.availableAt <= Date.now() || job.cancelRequested),
            )
            .map((job) => ({
              identity: state.identity,
              conversationId: state.id,
              job,
            }));
        }),
      };
    },
    prune: (identity, conversationId, before) =>
      records.mutate(conversationKey(identity, conversationId), (value) => {
        const state = stateFrom(value, identity, conversationId);
        const removed = state.jobs.filter(
          (job) => isTerminal(job.status) && job.updatedAt < before,
        );
        state.jobs = state.jobs.filter((job) => !removed.includes(job));
        return { value: state, result: removed.map((job) => job.id) };
      }),
  };
}
