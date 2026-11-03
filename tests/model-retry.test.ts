import { describe, expect, it } from "vitest";
import { createFakeProvider, run } from "../src/index.js";
import type { ProviderAdapter } from "../src/index.js";

const input = {
  tools: [],
  identity: { actorId: "a", tenantId: "t" },
  input: "hi",
  system: "s",
  get signal() {
    return AbortSignal.timeout(20_000);
  },
};
const ok = { content: "done", toolCalls: [], finishReason: "stop" } as const;
const failing = (
  errors: Error[],
  retries?: boolean,
): ProviderAdapter & { attempts: () => number } => {
  let attempts = 0;
  const base = createFakeProvider(() => ok);
  return {
    ...base,
    capabilities: { toolCalling: true, ...(retries && { retries }) },
    complete: async (request) => {
      const error = errors[attempts++];
      if (error) throw error;
      return base.complete(request);
    },
    attempts: () => attempts,
  };
};
const http = (status: number) => Object.assign(new Error("x"), { status });

describe("model call retry", () => {
  it("retries transient failures without extra rounds", async () => {
    const provider = failing([http(503), http(429)]);
    const rounds: number[] = [];
    const result = await run({
      ...input,
      provider,
      hooks: {
        onEvent: (event) => {
          if (event.type === "round_started") rounds.push(event.round);
        },
      },
    });
    expect(result).toEqual({ status: "completed", text: "done" });
    expect(provider.attempts()).toBe(3);
    expect(rounds).toEqual([1]);
  });

  it("retries network error names and gives up after 2 retries", async () => {
    const network = Object.assign(new Error("x"), { code: "ECONNRESET" });
    const provider = failing([network, network, network]);
    const result = await run({ ...input, provider });
    expect(result.status).toBe("failed");
    expect(provider.attempts()).toBe(3);
  });

  it("does not retry 4xx errors", async () => {
    const provider = failing([http(400)]);
    expect((await run({ ...input, provider })).status).toBe("failed");
    expect(provider.attempts()).toBe(1);
  });

  it("does not retry when the adapter retries itself", async () => {
    const provider = failing([http(503)], true);
    expect((await run({ ...input, provider })).status).toBe("failed");
    expect(provider.attempts()).toBe(1);
  });

  it("does not retry after abort", async () => {
    const controller = new AbortController();
    const provider = failing([http(503), http(503)]);
    const pending = run({
      ...input,
      provider,
      signal: controller.signal,
    });
    controller.abort();
    expect((await pending).status).not.toBe("completed");
    expect(provider.attempts()).toBeLessThanOrEqual(1);
  });
});
