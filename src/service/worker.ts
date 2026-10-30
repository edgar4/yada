import { contextWindow, type RunLimits } from "../core/limits.js";
import { operationId } from "../storage/actions.js";
import { actionExecutor } from "./actions.js";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderAdapter, Tool, Turn } from "../core/contracts.js";
import { CheckpointError } from "../core/checkpoint.js";
import { runDurable } from "../storage/durable-run.js";
import { RunLeaseError } from "../storage/runs.js";
import type { YadaStorage } from "../storage/index.js";
export type AgentProfile = Readonly<{
  provider: ProviderAdapter;
  tools: readonly Tool[];
  system: string;
  limits?: RunLimits;
  historyChars?: number;
  maxRounds?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}>;
export type Trace = Readonly<{
  event: "run_finished" | "run_retry";
  status: string;
  elapsedMs: number;
}>;
export function createWorker(options: {
  storage: YadaStorage;
  profiles: Readonly<Record<string, AgentProfile>>;
  leaseMs?: number;
  pollMs?: number;
  trace?: (event: Trace) => void;
}) {
  const shutdown = new AbortController();
  let cursor = "";
  let active: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  async function processPage() {
    const page = await options.storage.jobs.pending(cursor);
    cursor = page.cursor;
    for (const { identity, conversationId, job } of page.jobs) {
      if (shutdown.signal.aborted) break;
      const profile = options.profiles[job.profileId];
      if (!profile) continue;
      const started = Date.now();
      const cancellation = new AbortController();
      const checkCancellation = async () => {
        const latest = await options.storage.jobs.load(
          identity,
          conversationId,
          job.id,
        );
        if (latest?.cancelRequested) {
          const runId = JSON.stringify([conversationId, job.id]);
          const saved = await options.storage.runs.load(identity, runId);
          for (const call of saved?.checkpoint?.pending ?? []) {
            const action = await options.storage.actions.load(
              identity,
              operationId(identity, runId, call.id),
            );
            if (action?.status === "executing") return;
          }
          cancellation.abort();
        }
      };
      try {
        await checkCancellation();
        const history: Turn[] = job.history.map((turn) =>
          turn.role === "assistant"
            ? { role: "assistant", content: turn.content, toolCalls: [] }
            : { role: "user", content: turn.content },
        );
        const runs = options.storage.runs;
        const result = await runDurable({
          ...profile,
          executeWrite: actionExecutor(
            options.storage.actions,
            identity,
            JSON.stringify([conversationId, job.id]),
          ),
          history: contextWindow(history, profile.historyChars ?? 32_000),
          input: job.input,
          identity,
          runId: JSON.stringify([conversationId, job.id]),
          profileId: job.profileId,
          ...(options.leaseMs === undefined
            ? {}
            : { leaseMs: options.leaseMs }),
          signal: AbortSignal.any([
            shutdown.signal,
            cancellation.signal,
            AbortSignal.timeout(profile.timeoutMs ?? 60_000),
          ]),
          store: {
            ...runs,
            claim: async (...args) => {
              const state = await runs.claim(...args);
              await options.storage.jobs.update(
                identity,
                conversationId,
                job.id,
                { type: "running" },
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
              );
            },
            renew: async (...args) => {
              await checkCancellation();
              await runs.renew(...args);
            },
          },
        });
        await options.storage.jobs.update(
          identity,
          conversationId,
          job.id,
          {
            type: result.status,
            ...("approvalId" in result
              ? { approvalId: result.approvalId }
              : {}),
            ...(result.status === "completed"
              ? { text: result.text }
              : result.status === "failed"
                ? { code: result.code }
                : {}),
          },
          "approvalId" in result ? undefined : result,
        );
        options.trace?.({
          event: "run_finished",
          status: result.status,
          elapsedMs: Date.now() - started,
        });
      } catch (error) {
        if (!(error instanceof RunLeaseError))
          options.trace?.({
            event: "run_retry",
            status: "retryable",
            elapsedMs: Date.now() - started,
          });
      }
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
            options.trace?.({
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
