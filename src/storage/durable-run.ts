import { run } from "../core/runtime.js";
import type { RunStore } from "./runs.js";
export async function runDurable(
  options: Omit<
    Parameters<typeof run>[0],
    "history" | "checkpoint" | "persist"
  > & { runId: string; profileId: string; store: RunStore; leaseMs?: number },
) {
  const { store, runId, profileId, leaseMs = 30_000, ...runtime } = options;
  const request = {
    input: options.input,
    system: options.system,
    profileId,
    provider: options.provider.name,
    tools: options.tools.map((tool) => JSON.stringify(tool.spec)).sort(),
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
    return result;
  } finally {
    clearInterval(timer);
    await renewal;
  }
}
