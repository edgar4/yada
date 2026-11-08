import { z } from "zod";
import type { Identity, TerminalResult, Turn } from "../core/contracts.js";
import {
  awaitedApprovalId,
  isJobStatus,
  isTerminal,
  jobInputSchema,
  jobSchema,
  eventSchema,
  maxSteering,
  quotaSnapshotSchema,
  type QuotaSnapshot,
  type JobInput,
  type SteeringInput,
  type Job,
  type RunEvent,
  HttpError,
} from "../service/contracts.js";
import {
  conversationKey,
  retiredKey,
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
  quota: quotaSnapshotSchema.optional(),
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
const quarantineSchema = z.object({
  rowId: z.string(),
  revision: z.number(),
  at: z.number(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
  value: z.unknown(),
});
export type QuarantinedRecord = z.infer<typeof quarantineSchema>;
export type QuarantineReport = Readonly<{
  conversationId?: string;
  identity?: Identity;
  failed: readonly Readonly<{
    runId: string;
    profileId: string;
    quota?: QuotaSnapshot | undefined;
  }>[];
}>;
export const quarantineScope = (rowId: string) =>
  JSON.stringify(["quarantine", rowId]);
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? (value as unknown[]) : [];
const isZodError = (error: unknown) => error instanceof z.ZodError;
function salvageJob(raw: unknown, now: number): StoredJob | undefined {
  const parsed = storedJobSchema.safeParse(raw).data;
  if (parsed) return parsed;
  const record = z.record(z.string(), z.unknown()).safeParse(raw).data;
  const base = jobInputSchema.safeParse({
    id: record?.["id"],
    profileId: record?.["profileId"],
    input: record?.["input"],
  }).data;
  if (!record || !base) return undefined;
  const field = <T>(schema: z.ZodType<T>, key: string) =>
    schema.safeParse(record[key]).data;
  const history = field(jobSchema.shape.history, "history");
  const historyLength = field(z.number().int().nonnegative(), "historyLength");
  const outcome = field(jobSchema.shape.outcome, "outcome");
  const quota = field(quotaSnapshotSchema, "quota");
  return {
    ...base,
    createdAt: field(z.number(), "createdAt") ?? now,
    updatedAt: now,
    availableAt: 0,
    attempts: field(z.number().int().nonnegative(), "attempts") ?? 0,
    status: field(jobSchema.shape.status, "status") ?? "running",
    cancelRequested: false,
    steering: asArray(record["steering"]).flatMap((item) => {
      const steering = jobSchema.shape.steering
        .unwrap()
        .element.safeParse(item);
      return steering.success ? [steering.data] : [];
    }),
    events: asArray(record["events"]).map((item, index): RunEvent => {
      const event = eventSchema.safeParse(item).data;
      return {
        ...(event ?? { version: 1, type: "progress", at: now }),
        sequence: index + 1,
      };
    }),
    ...(history ? { history } : {}),
    ...(historyLength === undefined ? {} : { historyLength }),
    ...(outcome ? { outcome } : {}),
    ...(quota ? { quota } : {}),
  };
}
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
    settings?: Readonly<{ quota?: QuotaSnapshot | undefined }>,
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
  pending(
    after?: string,
    onCorrupt?: (error: Error, report: QuarantineReport) => void,
  ): Promise<{
    cursor: string;
    jobs: {
      identity: Identity;
      conversationId: string;
      job: Job;
      quota?: QuotaSnapshot | undefined;
    }[];
  }>;
  quarantined(
    after?: string,
    limit?: number,
  ): Promise<{ records: QuarantinedRecord[]; cursor: string }>;
  discardQuarantined(rowId: string): Promise<void>;
  repair(
    identity: Identity,
    conversationId: string,
    error: Error,
  ): Promise<void>;
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
    if (!job) throw new HttpError(404, "Run not found");
    return { state, job };
  };
  const view = (state: ConversationState, job: StoredJob): Job => {
    const { historyLength = 0, ...rest } = job;
    delete rest.quota;
    return {
      ...rest,
      history: job.history ?? state.messages.slice(0, historyLength),
    };
  };
  const finish = <T>(
    state: ConversationState,
    result: T,
    retired: readonly string[] = [],
  ) => ({
    value: state,
    result,
    active: state.jobs.some((job) => !isTerminal(job.status)),
    retired,
  });
  const retire = (state: ConversationState, removed: readonly StoredJob[]) => {
    if (!removed.length) return [];
    const ids = [...state.retiredRuns, ...removed.map((job) => job.id)];
    state.retiredRuns = [];
    state.jobs = state.jobs.filter((job) => !removed.includes(job));
    return ids;
  };
  const append = (
    job: StoredJob,
    event: Omit<RunEvent, "version" | "sequence" | "at">,
  ) => {
    const previous = job.events.at(-1);
    const status = isJobStatus(event.type) ? event.type : undefined;
    job.updatedAt = Date.now();
    if (status) {
      job.status = status;
      job.availableAt =
        event.type === "awaiting_approval"
          ? (event.expiresAt ?? Date.now() + 600_000)
          : Date.now() + (event.type === "reconciling" ? 5000 : 0);
    }
    if (
      status &&
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
    job.events.push(
      eventSchema.parse({
        ...event,
        version: 1,
        sequence: job.events.length + 1,
        at: job.updatedAt,
      }),
    );
  };
  const unreported: { error: Error; report: QuarantineReport }[] = [];
  const unreadable = new Set<string>();
  const keepCopy = async (
    tx: ReturnType<typeof recordStore>,
    rowId: string,
    revision: number,
    value: unknown,
    error: Error,
  ) => {
    const key = JSON.stringify(["quarantine", rowId, String(revision)]);
    if (await tx.read(key)) return;
    await tx.write(
      key,
      {
        rowId,
        revision,
        at: Date.now(),
        issues:
          error instanceof z.ZodError
            ? error.issues.slice(0, 20).map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              }))
            : [{ path: "", message: error.message }],
        value,
      },
      0,
    );
  };
  const salvage = (raw: unknown, identity: Identity, id: string) => {
    const now = Date.now();
    const record = Array.isArray(raw)
      ? { messages: raw as unknown }
      : (z.record(z.string(), z.unknown()).safeParse(raw).data ?? {});
    const strings = (value: unknown) =>
      asArray(value).filter((item) => typeof item === "string");
    const rawJobs = asArray(record["jobs"]);
    const jobs = rawJobs.map((job) => salvageJob(job, now));
    const lost = rawJobs.flatMap((job, index) => {
      const lostId = z.object({ id: z.string() }).safeParse(job).data?.id;
      return !jobs[index] && lostId ? [lostId] : [];
    });
    const state: ConversationState = {
      identity,
      id,
      messages: asArray(record["messages"]).flatMap((item) => {
        const message = messageSchema.safeParse(item);
        return message.success ? [message.data] : [];
      }),
      deleted: record["deleted"] === true,
      retiredRuns: [...strings(record["retiredRuns"]), ...lost],
      purgeRuns: strings(record["purgeRuns"]),
      jobs: jobs.filter((job) => job !== undefined),
    };
    const failed: StoredJob[] = [];
    for (const job of state.jobs) {
      if (isTerminal(job.status)) continue;
      job.cancelRequested = true;
      append(job, { type: "failed", code: "corrupt_record" });
      job.outcome = { status: "failed", code: "corrupt_record" };
      state.messages.push(
        { role: "user", content: job.input },
        { role: "failure", code: "corrupt_record" },
      );
      failed.push(job);
    }
    return { state, failed };
  };
  const repair = (identity: Identity, id: string, error: Error) => {
    const key = conversationKey(identity, id);
    return records.transact(async (tx) => {
      const record = await tx.read(key);
      if (!record) return undefined;
      try {
        stateFrom(record.value, identity, id);
        return undefined;
      } catch (invalid) {
        if (!isZodError(invalid)) throw invalid;
      }
      await keepCopy(tx, tx.rowId(key), record.revision, record.value, error);
      const { state, failed } = salvage(record.value, identity, id);
      await tx.write(
        key,
        state,
        record.revision,
        state.jobs.some((job) => !isTerminal(job.status)),
      );
      return {
        identity,
        conversationId: id,
        failed: failed.map((job) => ({
          runId: job.id,
          profileId: job.profileId,
          quota: job.quota,
        })),
      } satisfies QuarantineReport;
    });
  };
  const repairAndReport = async (
    identity: Identity,
    id: string,
    error: Error,
  ) => {
    const report = await repair(identity, id, error);
    if (report) unreported.push({ error, report });
  };
  const quarantine = async (
    row: Readonly<{ id: string; revision: number; value: unknown }>,
    error: Error,
  ) => {
    const owner = z
      .object({ identity: identitySchema, id: z.string().min(1) })
      .safeParse(row.value).data;
    if (
      owner &&
      records.rowId(conversationKey(owner.identity, owner.id)) === row.id
    ) {
      await repairAndReport(owner.identity, owner.id, error);
      return;
    }
    const isolated = await records.transact(async (tx) => {
      await keepCopy(tx, row.id, row.revision, row.value, error);
      return tx.deactivate(row.id, row.revision);
    });
    if (isolated) unreported.push({ error, report: { failed: [] } });
  };
  const mutateJob = <T>(
    identity: Identity,
    conversationId: string,
    id: string,
    lease: RunOwnership | undefined,
    change: (value: unknown) => ReturnType<typeof finish<T>>,
  ) => {
    const key = conversationKey(identity, conversationId);
    const run = async (
      tx: ReturnType<typeof recordStore>,
      assertOwned = () => {},
    ) => {
      const conversation = await tx.read(key);
      const next = change(conversation?.value);
      assertOwned();
      await tx.write(key, next.value, conversation?.revision ?? 0, next.active);
      for (const runId of next.retired) {
        const tombstone = retiredKey(identity, conversationId, runId);
        await tx.write(tombstone, { key: tombstone }, 0);
      }
      return next.result;
    };
    if (!lease) return records.transact((tx) => run(tx));
    if (lease.runId !== JSON.stringify([conversationId, id]))
      return Promise.reject(new RunLeaseError());
    return withRunLease(records, identity, lease, run);
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
      let retired: string[] = [];
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
        retired = retire(
          state,
          state.jobs
            .filter((item) => isTerminal(item.status))
            .slice(0, -keptTerminalJobs),
        );
      }
      return finish(state, view(state, job), retired);
    });
  return {
    submit: async (identity, conversationId, input, settings) => {
      const parsed = jobInputSchema.parse(input);
      const key = conversationKey(identity, conversationId);
      const attempt = () =>
        records.transact(async (tx) => {
          const record = await tx.read(key);
          const state = stateFrom(record?.value, identity, conversationId);
          if (state.deleted) throw new HttpError(410, "Conversation erased");
          if (
            state.retiredRuns.includes(parsed.id) ||
            (await tx.read(retiredKey(identity, conversationId, parsed.id)))
          )
            throw new JobConflict();
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
            ...(settings?.quota ? { quota: settings.quota } : {}),
          };
          append(job, { type: "queued" });
          state.jobs.push(job);
          await tx.write(key, state, record?.revision ?? 0, true);
          return view(state, job);
        });
      return attempt().catch(async (error: unknown) => {
        if (!(error instanceof z.ZodError)) throw error;
        await repairAndReport(identity, conversationId, error);
        return attempt();
      });
    },
    async load(identity, conversationId, id) {
      const key = conversationKey(identity, conversationId);
      const read = async () => {
        const record = await records.read(key);
        if (!record) return undefined;
        const state = stateFrom(record.value, identity, conversationId);
        const job = state.jobs.find((item) => item.id === id);
        return job && view(state, job);
      };
      return read().catch(async (error: unknown) => {
        if (!(error instanceof z.ZodError)) throw error;
        await repairAndReport(identity, conversationId, error);
        return read();
      });
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
        const waiting = awaitedApprovalId(job) === approvalId;
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
    async pending(after = "", onCorrupt) {
      const rows = await records.scanReadable("conversation", after, 100, true);
      const jobs: {
        identity: Identity;
        conversationId: string;
        job: Job;
        quota?: QuotaSnapshot | undefined;
      }[] = [];
      for (const row of rows) {
        if (row.unreadable) {
          if (!unreadable.has(row.id)) {
            unreadable.add(row.id);
            unreported.push({
              error: new Error("Conversation record cannot be decrypted"),
              report: { failed: [] },
            });
          }
          continue;
        }
        const parsed = conversationStateSchema.safeParse(row.value);
        if (!parsed.success) {
          await quarantine(row, parsed.error).catch(() => undefined);
          continue;
        }
        const state = parsed.data;
        for (const job of state.jobs)
          if (
            !isTerminal(job.status) &&
            (job.availableAt <= Date.now() ||
              job.cancelRequested ||
              job.status === "awaiting_approval")
          )
            jobs.push({
              identity: state.identity,
              conversationId: state.id,
              job: view(state, job),
              ...(job.quota ? { quota: job.quota } : {}),
            });
      }
      for (const { error, report } of unreported.splice(0))
        onCorrupt?.(error, report);
      return {
        cursor: rows.length < 100 ? "" : (rows.at(-1)?.id ?? ""),
        jobs,
      };
    },
    async quarantined(after = "", limit = 100) {
      const rows = await records.scan("quarantine", after, limit);
      return {
        records: rows.map((row) => quarantineSchema.parse(row.value)),
        cursor: rows.length < limit ? "" : (rows.at(-1)?.id ?? ""),
      };
    },
    discardQuarantined: (rowId) =>
      records.removeScope("quarantine", quarantineScope(rowId)),
    repair: repairAndReport,
    prune: (identity, conversationId, before) =>
      mutateJob(identity, conversationId, "", undefined, (value) => {
        const state = stateFrom(value, identity, conversationId);
        const removed = state.jobs.filter(
          (job) => isTerminal(job.status) && job.updatedAt < before,
        );
        return finish(
          state,
          removed.map((job) => job.id),
          retire(state, removed),
        );
      }),
  };
}
