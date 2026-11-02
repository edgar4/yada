import { contextWindow, type RunLimits } from "../core/limits.js";
import { modelHistory } from "../storage/conversations.js";
import { runTree } from "../storage/actions.js";
import { actionExecutor } from "./actions.js";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ProviderAdapter,
  TerminalResult,
  Tool,
  Turn,
} from "../core/contracts.js";
import { CheckpointError } from "../core/checkpoint.js";
import { runDurable } from "../storage/durable-run.js";
import { runTurns, type SummarizeOptions } from "../core/runtime.js";
import { RunLeaseError, type RunOwnership } from "../storage/runs.js";
import type { YadaStorage } from "../storage/index.js";
import type { JobStore } from "../storage/jobs.js";
import { isTerminal, type RunEvent } from "./contracts.js";
import { eventKey, type EventBus } from "./events.js";
import { composeHooks, type AgentEvent, type RunHooks } from "../core/hooks.js";
export type AgentProfile = Readonly<{
  provider: ProviderAdapter;
  tools: readonly Tool[];
  system: string;
  limits?: RunLimits;
  hooks?: RunHooks;
  historyChars?: number;
  historyToolChars?: number;
  approvalTtlMs?: number;
  maxRounds?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  summarize?: SummarizeOptions;
}>;
const completeOnly = (provider: ProviderAdapter): ProviderAdapter => ({
  name: provider.name,
  capabilities: provider.capabilities,
  complete: (request) => provider.complete(request),
});
export type Trace = Readonly<{
  event: "run_finished" | "run_retry";
  status: string;
  elapsedMs: number;
  attempt?: number;
  code?: string;
  rounds?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
}>;
export function createWorker(options: {
  storage: YadaStorage;
  profiles: Readonly<Record<string, AgentProfile>>;
  leaseMs?: number;
  pollMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  bus?: EventBus;
  trace?: (event: Trace) => void | Promise<void>;
}) {
  const shutdown = new AbortController();
  let cursor = "";
  let scanning: Promise<{ done: Promise<unknown> }> | undefined;
  let loop: Promise<void> | undefined;
  const running = new Map<string, Promise<void>>();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const trace = (event: Trace) => {
    void Promise.resolve()
      .then(() => options.trace?.(event))
      .catch(() => undefined);
  };
  async function schedule() {
    if (running.size >= concurrency) return { done: Promise.resolve() };
    const page = await options.storage.jobs.pending(cursor);
    const started: Promise<void>[] = [];
    let consumed = true;
    for (const entry of page.jobs) {
      if (shutdown.signal.aborted) break;
      if (!Object.hasOwn(options.profiles, entry.job.profileId)) continue;
      const key = JSON.stringify([
        entry.identity.tenantId,
        entry.identity.actorId,
        entry.conversationId,
        entry.job.id,
      ]);
      if (running.has(key)) continue;
      if (running.size >= concurrency) {
        consumed = false;
        break;
      }
      const task = processJob(entry)
        .catch(() => undefined)
        .finally(() => running.delete(key));
      running.set(key, task);
      started.push(task);
    }
    if (consumed) cursor = page.cursor;
    return { done: Promise.all(started) };
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
    const bus = options.bus;
    const busKey = eventKey(identity, conversationId, job.id);
    const runs = options.storage.runs;
    const loadJob = () =>
      options.storage.jobs.load(identity, conversationId, job.id);
    const updateJob = (
      ...args: [
        event: Parameters<JobStore["update"]>[3],
        outcome?: TerminalResult,
        lease?: RunOwnership,
        turns?: readonly Turn[],
      ]
    ) => options.storage.jobs.update(identity, conversationId, job.id, ...args);
    let token = "";
    let sequence = job.events.length;
    let consumed = 0;
    let recording = Promise.resolve();
    const record = async (event: AgentEvent) => {
      if (event.type === "text_delta")
        return bus?.publish(busKey, {
          version: 1,
          sequence,
          type: "text_delta",
          at: Date.now(),
          text: event.delta,
        });
      const mapped: Omit<RunEvent, "version" | "sequence" | "at"> | undefined =
        event.type === "tool_started"
          ? profile.tools.find((tool) => tool.spec.name === event.call.name)
              ?.effect === "write"
            ? undefined
            : { type: "tool_started", tool: event.call.name }
          : event.type === "tool_finished"
            ? {
                type: "tool_finished",
                tool: event.call.name,
                failed: event.failed,
              }
            : event.type === "model_finished" && event.usage
              ? { type: "usage", ...event.usage }
              : undefined;
      if (!mapped) return;
      const updated = await updateJob(mapped, undefined, { runId, token });
      sequence = updated.events.length;
    };
    const executing = async () => {
      const tree = await runTree(runs, identity, runId, true);
      for (const id of tree.actionIds) {
        const action = await options.storage.actions.load(identity, id);
        if (action?.status === "executing") return true;
      }
      return false;
    };
    const checkCancellation = async () => {
      const latest = await loadJob();
      if (latest?.cancelRequested && !(await executing())) cancellation.abort();
    };
    const counters = async (): Promise<Partial<Trace>> => {
      const saved = (await runs.load(identity, runId))?.checkpoint;
      return saved
        ? {
            rounds: saved.rounds,
            toolCalls: saved.calls,
            ...(saved.usage ?? {}),
          }
        : {};
    };
    const eligible = async () => {
      const current = await loadJob();
      return (
        current &&
        !isTerminal(current.status) &&
        (current.cancelRequested || current.availableAt <= Date.now())
      );
    };
    const traceFinished = async (status: string, code?: string) => {
      trace({
        event: "run_finished",
        status,
        elapsedMs: Date.now() - started,
        attempt: job.attempts + 1,
        ...(code === undefined ? {} : { code }),
        ...(await counters()),
      });
    };
    const finalize = async (result: TerminalResult) => {
      const latest = await loadJob();
      const final: TerminalResult =
        result.status === "cancelled" &&
        !latest?.cancelRequested &&
        !shutdown.signal.aborted
          ? { status: "failed", code: "timeout" }
          : result;
      const messages =
        final.status === "completed"
          ? (await runs.load(identity, runId))?.checkpoint?.messages
          : undefined;
      const steered = (await runs.load(identity, runId))?.checkpoint?.steered;
      const turns = messages && runTurns(messages, steered?.length);
      await updateJob(
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
      await traceFinished(
        final.status,
        final.status === "failed" ? final.code : undefined,
      );
    };
    const handleFailure = async (error: unknown) => {
      if (error instanceof RunLeaseError || shutdown.signal.aborted) return;
      const held = (await runs.load(identity, runId))?.lease;
      if (held && held.token !== token && held.expiresAt > Date.now()) return;
      const latest = await loadJob();
      if (!latest || isTerminal(latest.status)) return;
      const attempt = latest.attempts + 1;
      const exhausted =
        attempt >= (options.maxAttempts ?? 5) &&
        latest.status !== "reconciling" &&
        !(await executing().catch(() => true));
      if (exhausted)
        await updateJob(
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
    };
    try {
      await checkCancellation();
      const history = contextWindow(
        modelHistory(job.history),
        profile.historyChars ?? 128_000,
        profile.historyToolChars,
      );
      const result = await runDurable({
        ...profile,
        provider: bus ? profile.provider : completeOnly(profile.provider),
        hooks: composeHooks(...(profile.hooks ? [profile.hooks] : []), {
          onEvent: (event) => {
            recording = recording.then(() => record(event)).catch(() => {});
            return undefined;
          },
        }),
        executeWrite: actionExecutor(
          options.storage.actions,
          identity,
          runId,
          profile.approvalTtlMs,
        ),
        history,
        input: job.input,
        drainSteering: async () =>
          (await loadJob())?.steering.flatMap((item) =>
            item.consumed ? [] : [{ id: item.id, content: item.input }],
          ) ?? [],
        identity,
        runId,
        profileId: job.profileId,
        onSuspend: async (result, token) => {
          await recording;
          const action =
            result.status === "awaiting_approval"
              ? await options.storage.actions.load(identity, result.approvalId)
              : undefined;
          await updateJob(
            {
              type: result.status,
              approvalId: result.approvalId,
              ...(action ? { expiresAt: action.expiresAt } : {}),
            },
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
            if (args[1] !== runId) return runs.claim(...args);
            if (!(await eligible())) throw new RunLeaseError();
            const state = await runs.claim(...args);
            if (state.lease) token = state.lease.token;
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
              await updateJob({ type: "running" }, undefined, {
                runId,
                token: state.lease.token,
              });
            return state;
          },
          save: async (...args) => {
            if (shutdown.signal.aborted) throw new CheckpointError();
            if (args[1] !== runId) return runs.save(...args);
            await runs.save(...args);
            const lease = { runId: args[1], token: args[2] };
            await updateJob({ type: "progress" }, undefined, lease);
            const steered = args[3].steered ?? [];
            if (steered.length > consumed) {
              await options.storage.jobs.consumeSteering(
                identity,
                conversationId,
                job.id,
                steered,
                lease,
              );
              consumed = steered.length;
            }
          },
          renew: async (...args) => {
            await checkCancellation().catch(() => undefined);
            await runs.renew(...args);
          },
        },
      });
      await recording;
      if ("approvalId" in result) await traceFinished(result.status);
      else await finalize(result);
    } catch (error) {
      await handleFailure(error);
    }
  }
  const scan = () =>
    (scanning ??= schedule().finally(() => {
      scanning = undefined;
    }));
  async function tick() {
    await (
      await scan()
    ).done;
  }
  return {
    tick,
    start() {
      if (loop) throw new Error("Worker already started");
      loop = (async () => {
        while (!shutdown.signal.aborted) {
          try {
            await scan();
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
      await scanning?.catch(() => undefined);
      await loop;
      await Promise.all(running.values());
    },
  };
}
