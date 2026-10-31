import { contextWindow, type RunLimits } from "../core/limits.js";
import { modelHistory } from "../storage/conversations.js";
import { operationId } from "../storage/actions.js";
import { actionExecutor } from "./actions.js";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ProviderAdapter,
  TerminalResult,
  Tool,
} from "../core/contracts.js";
import { CheckpointError } from "../core/checkpoint.js";
import { runDurable } from "../storage/durable-run.js";
import { RunLeaseError } from "../storage/runs.js";
import type { YadaStorage } from "../storage/index.js";
import { isTerminal } from "./contracts.js";
export type AgentProfile = Readonly<{
  provider: ProviderAdapter;
  tools: readonly Tool[];
  system: string;
  limits?: RunLimits;
  historyChars?: number;
  historyToolChars?: number;
  approvalTtlMs?: number;
  maxRounds?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}>;
export type Trace = Readonly<{
  event: "run_finished" | "run_retry";
  status: string;
  elapsedMs: number;
  attempt?: number;
  code?: string;
}>;
export function createWorker(options: {
  storage: YadaStorage;
  profiles: Readonly<Record<string, AgentProfile>>;
  leaseMs?: number;
  pollMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  trace?: (event: Trace) => void | Promise<void>;
}) {
  const shutdown = new AbortController();
  let cursor = "";
  let active: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  const trace = (event: Trace) => {
    void Promise.resolve()
      .then(() => options.trace?.(event))
      .catch(() => undefined);
  };
  async function processPage() {
    const page = await options.storage.jobs.pending(cursor);
    cursor = page.cursor;
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const tasks = new Set<Promise<void>>();
    for (const entry of page.jobs) {
      if (shutdown.signal.aborted) break;
      if (!Object.hasOwn(options.profiles, entry.job.profileId)) continue;
      while (tasks.size >= concurrency) await Promise.race(tasks);
      const task = processJob(entry)
        .catch(() => undefined)
        .finally(() => tasks.delete(task));
      tasks.add(task);
    }
    await Promise.all(tasks);
  }
  async function processJob({
    identity,
    conversationId,
    job,
  }: Awaited<ReturnType<YadaStorage["jobs"]["pending"]>>["jobs"][number]) {
    const profile = options.profiles[job.profileId];
    if (!profile) return;
    const started = Date.now();
    const cancellation = new AbortController();
    const runId = JSON.stringify([conversationId, job.id]);
    const executing = async () => {
      const saved = await options.storage.runs.load(identity, runId);
      for (const call of saved?.checkpoint?.pending ?? []) {
        const action = await options.storage.actions.load(
          identity,
          operationId(identity, runId, call.id),
        );
        if (action?.status === "executing") return true;
      }
      return false;
    };
    const checkCancellation = async () => {
      const latest = await options.storage.jobs.load(
        identity,
        conversationId,
        job.id,
      );
      if (latest?.cancelRequested && !(await executing())) cancellation.abort();
    };
    try {
      await checkCancellation();
      const history = contextWindow(
        modelHistory(job.history),
        profile.historyChars ?? 32_000,
        profile.historyToolChars,
      );
      const runs = options.storage.runs;
      const eligible = async () => {
        const current = await options.storage.jobs.load(
          identity,
          conversationId,
          job.id,
        );
        return (
          current &&
          !isTerminal(current.status) &&
          (current.cancelRequested || current.availableAt <= Date.now())
        );
      };
      const result = await runDurable({
        ...profile,
        executeWrite: actionExecutor(
          options.storage.actions,
          identity,
          runId,
          profile.approvalTtlMs,
        ),
        history,
        input: job.input,
        identity,
        runId,
        profileId: job.profileId,
        onSuspend: async (result, token) => {
          await options.storage.jobs.update(
            identity,
            conversationId,
            job.id,
            { type: result.status, approvalId: result.approvalId },
            undefined,
            { runId, token },
          );
        },
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        signal: AbortSignal.any([
          shutdown.signal,
          cancellation.signal,
          AbortSignal.timeout(profile.timeoutMs ?? 300_000),
        ]),
        store: {
          ...runs,
          claim: async (...args) => {
            if (!(await eligible())) throw new RunLeaseError();
            const state = await runs.claim(...args);
            if (!(await eligible())) {
              if (state.lease && !state.checkpoint?.outcome)
                await runs.release(identity, args[1], state.lease.token);
              throw new RunLeaseError();
            }
            if (
              job.status !== "reconciling" &&
              state.lease &&
              !state.checkpoint?.outcome
            )
              await options.storage.jobs.update(
                identity,
                conversationId,
                job.id,
                { type: "running" },
                undefined,
                { runId, token: state.lease.token },
              );
            return state;
          },
          save: async (...args) => {
            if (shutdown.signal.aborted) throw new CheckpointError();
            await runs.save(...args);
            await options.storage.jobs.update(
              identity,
              conversationId,
              job.id,
              { type: "progress" },
              undefined,
              { runId: args[1], token: args[2] },
            );
          },
          renew: async (...args) => {
            await checkCancellation();
            await runs.renew(...args);
          },
        },
      });
      if (!("approvalId" in result)) {
        const latest = await options.storage.jobs.load(
          identity,
          conversationId,
          job.id,
        );
        const final: TerminalResult =
          result.status === "cancelled" &&
          !latest?.cancelRequested &&
          !shutdown.signal.aborted
            ? { status: "failed", code: "timeout" }
            : result;
        const turns =
          final.status === "completed"
            ? (await runs.load(identity, runId))?.checkpoint?.messages.slice(
                history.length,
              )
            : undefined;
        await options.storage.jobs.update(
          identity,
          conversationId,
          job.id,
          {
            type: final.status,
            ...(final.status === "completed"
              ? { text: final.text }
              : final.status === "failed"
                ? { code: final.code }
                : {}),
          },
          final,
          undefined,
          turns,
        );
        trace({
          event: "run_finished",
          status: final.status,
          elapsedMs: Date.now() - started,
          attempt: job.attempts + 1,
          ...(final.status === "failed" ? { code: final.code } : {}),
        });
        return;
      }
      trace({
        event: "run_finished",
        status: result.status,
        elapsedMs: Date.now() - started,
        attempt: job.attempts + 1,
      });
    } catch (error) {
      if (error instanceof RunLeaseError || shutdown.signal.aborted) return;
      const attempt = job.attempts + 1;
      const exhausted =
        attempt >= (options.maxAttempts ?? 5) &&
        job.status !== "reconciling" &&
        !(await executing().catch(() => true));
      if (exhausted)
        await options.storage.jobs.update(
          identity,
          conversationId,
          job.id,
          { type: "failed", code: "retry_exhausted" },
          { status: "failed", code: "retry_exhausted" },
        );
      else await options.storage.jobs.retry(identity, conversationId, job.id);
      trace({
        event: exhausted ? "run_finished" : "run_retry",
        status: exhausted ? "failed" : "retryable",
        elapsedMs: Date.now() - started,
        attempt,
        ...(exhausted ? { code: "retry_exhausted" } : {}),
      });
    }
  }
  function tick() {
    active ??= processPage().finally(() => {
      active = undefined;
    });
    return active;
  }
  return {
    tick,
    start() {
      if (loop) throw new Error("Worker already started");
      loop = (async () => {
        while (!shutdown.signal.aborted) {
          try {
            await tick();
          } catch {
            trace({
              event: "run_retry",
              status: "storage_unavailable",
              elapsedMs: 0,
            });
          }
          try {
            await delay(options.pollMs ?? 500, undefined, {
              signal: shutdown.signal,
            });
          } catch {
            break;
          }
        }
      })();
    },
    async stop() {
      shutdown.abort();
      await active;
      await loop;
    },
  };
}
