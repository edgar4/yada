import { limitsSchema } from "../core/limits.js";
import { turnSchema } from "../core/checkpoint.js";
import { run } from "../core/runtime.js";
import type { RunStore } from "./runs.js";
import type { Suspension } from "../core/action.js";
export async function runDurable(
  options: Omit<Parameters<typeof run>[0], "checkpoint" | "persist"> & {
    runId: string;
    profileId: string;
    store: RunStore;
    leaseMs?: number;
    onSuspend?: (result: Suspension, token: string) => Promise<void>;
  },
) {
  const {
    store,
    runId,
    profileId,
    leaseMs = 30_000,
    onSuspend,
    ...runtime
  } = options;
  const request = {
    input: options.input,
    limits: limitsSchema.parse(options.limits ?? {}),
    history: turnSchema.array().parse(options.history ?? []),
    system: options.system,
    profileId,
    provider: options.provider.name,
    tools: options.tools
      .map((tool) =>
        JSON.stringify({
          ...tool.spec,
          ...(tool.effect === "write"
            ? { effect: tool.effect, version: tool.version }
            : {}),
        }),
      )
      .sort(),
    maxRounds: options.maxRounds ?? 8,
    maxToolCalls: options.maxToolCalls ?? 16,
  };
  const state = await store.claim(options.identity, runId, request, leaseMs);
  if (state.checkpoint?.outcome) return state.checkpoint.outcome;
  if (!state.lease) throw new Error("Missing run lease");
  const token = state.lease.token;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let lost: Error | undefined;
  let renewal: Promise<void> | undefined;
  const timer = setInterval(
    () => {
      if (renewal) return;
      renewal = store
        .renew(options.identity, runId, token, leaseMs)
        .catch((error: unknown) => {
          lost =
            error instanceof Error
              ? error
              : new Error("Run lease renewal failed");
          controller.abort();
        })
        .finally(() => {
          renewal = undefined;
        });
    },
    Math.floor(leaseMs / 3),
  );
  try {
    const result = await run({
      ...runtime,
      signal,
      ...(state.checkpoint ? { checkpoint: state.checkpoint } : {}),
      persist: async (checkpoint) => {
        if (lost) throw lost;
        await store.save(options.identity, runId, token, checkpoint, leaseMs);
      },
    });
    if (lost) throw lost;
    if (
      result.status === "awaiting_approval" ||
      result.status === "reconciling"
    ) {
      await onSuspend?.(result, token);
      clearInterval(timer);
      await renewal;
      await store.release(options.identity, runId, token);
    }
    return result;
  } finally {
    clearInterval(timer);
    await renewal;
  }
}
