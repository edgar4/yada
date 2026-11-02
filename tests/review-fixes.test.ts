import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  agentTool,
  createFakeProvider,
  createProvider,
  readTool,
  run,
} from "../src/index.js";
import { transient } from "../src/core/transient.js";
import type { ProviderAdapter, ProviderResult } from "../src/index.js";
import { chatReply, claudeReply, stubFetch } from "./helpers/http.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const identity = { actorId: "a", tenantId: "t" };
const input = {
  tools: [],
  identity,
  input: "hi",
  system: "s",
  get signal() {
    return AbortSignal.timeout(20_000);
  },
};
const say = (content: string): ProviderResult => ({
  content,
  toolCalls: [],
  finishReason: "stop",
});

describe("transient", () => {
  class APIConnectionError extends Error {}
  it.each([
    [Object.assign(new Error("x"), { status: 503 }), true],
    [Object.assign(new Error("x"), { status: 400 }), false],
    [new APIConnectionError("x"), true],
    [new Error("x", { cause: { code: "ECONNRESET" } }), true],
    [new Error("x", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), true],
    [Object.assign(new Error("x"), { name: "AbortError" }), false],
    [new Error("plain"), false],
  ])("classifies %o", (error, expected) => {
    expect(transient(error)).toBe(expected);
  });
});

describe("stream retry", () => {
  const streaming = (failures: (Error | undefined)[]) => {
    let attempts = 0;
    const provider: ProviderAdapter = {
      name: "s",
      capabilities: { toolCalling: true },
      complete: () => Promise.resolve(say("done")),
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream() {
        const failure = failures[attempts++];
        if (failure) throw failure;
        yield { type: "text" as const, delta: "d" };
        return say("done");
      },
    };
    return { provider, attempts: () => attempts };
  };
  const hooks = { onEvent: () => undefined };
  it("retries a failure before the first chunk", async () => {
    const s = streaming([
      Object.assign(new Error("x"), { status: 503 }),
      undefined,
    ]);
    const result = await run({ ...input, provider: s.provider, hooks });
    expect(result).toEqual({ status: "completed", text: "done" });
    expect(s.attempts()).toBe(2);
  });
  it("does not retry after a chunk", async () => {
    let attempts = 0;
    const provider: ProviderAdapter = {
      name: "s",
      capabilities: { toolCalling: true },
      complete: () => Promise.resolve(say("done")),
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream() {
        attempts++;
        yield { type: "text" as const, delta: "d" };
        throw Object.assign(new Error("x"), { status: 503 });
      },
    };
    expect((await run({ ...input, provider, hooks })).status).toBe("failed");
    expect(attempts).toBe(1);
  });
});

it("returns when an event hook hangs", async () => {
  vi.useFakeTimers();
  const pending = run({
    ...input,
    provider: createFakeProvider(() => say("done")),
    hooks: { onEvent: () => new Promise<void>(() => undefined) },
  });
  await vi.advanceTimersByTimeAsync(5001);
  expect(await pending).toEqual({ status: "completed", text: "done" });
});

describe("agentTool", () => {
  const sub = (options: object = {}) =>
    agentTool({
      name: "sub",
      description: "d",
      system: "s",
      provider: createFakeProvider(() => say("x")),
      tools: [],
      ...options,
    });
  it("has no tool timeout unless set", () => {
    expect(sub().timeoutMs).toBe(Infinity);
    expect(sub({ timeoutMs: 5 }).timeoutMs).toBe(5);
  });
  it("caps the child cost at the parent's remaining budget", async () => {
    const parentLimits = {
      maxCostMicros: 1000,
      pricing: { inputMicrosPer1k: 1000, outputMicrosPer1k: 1000 },
    };
    const seen: (number | undefined)[] = [];
    const nested = vi.fn((child: { limits?: { maxCostMicros?: number } }) => {
      seen.push(child.limits?.maxCostMicros);
      return Promise.resolve({
        result: { status: "completed" as const, text: "ok" },
        usage: undefined,
      });
    });
    await sub().execute(
      { task: "go" },
      identity,
      new AbortController().signal,
      {
        addUsage: () => undefined,
        maxOutput: 100,
        limits: parentLimits,
        remainingCostMicros: 400,
        runChild: nested as never,
      },
    );
    expect(seen).toEqual([400]);
  });
  it("reports the parent's remaining cost to its tools", async () => {
    let remaining: number | undefined;
    const probe = readTool({
      name: "probe",
      description: "d",
      input: z.strictObject({}),
      authorize: () => Promise.resolve(true),
      execute: (_a, _i, _s, toolRun) => {
        remaining = toolRun?.remainingCostMicros;
        return Promise.resolve("ok");
      },
    });
    const provider = createFakeProvider((_r, n) =>
      n === 1
        ? {
            content: "",
            toolCalls: [{ id: "c", name: "probe", args: {} }],
            finishReason: "tool_calls",
            usage: { inputTokens: 100, outputTokens: 0 },
          }
        : say("done"),
    );
    await run({
      ...input,
      provider,
      tools: [probe],
      limits: {
        maxCostMicros: 1000,
        pricing: { inputMicrosPer1k: 1000, outputMicrosPer1k: 1000 },
      },
    });
    expect(remaining).toBe(900);
  });
  it("splits the remaining cost across parallel calls", async () => {
    const seen: (number | undefined)[] = [];
    const probe = readTool({
      name: "probe",
      description: "d",
      input: z.strictObject({}),
      authorize: () => Promise.resolve(true),
      execute: (_a, _i, _s, toolRun) => {
        seen.push(toolRun?.remainingCostMicros);
        return Promise.resolve("ok");
      },
    });
    const provider = createFakeProvider((_r, n) =>
      n === 1
        ? {
            content: "",
            toolCalls: [
              { id: "a", name: "probe", args: {} },
              { id: "b", name: "probe", args: {} },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 100, outputTokens: 0 },
          }
        : say("done"),
    );
    await run({
      ...input,
      provider,
      tools: [probe],
      limits: {
        maxCostMicros: 1000,
        pricing: { inputMicrosPer1k: 1000, outputMicrosPer1k: 1000 },
      },
    });
    expect(seen).toEqual([450, 450]);
  });
});

describe("providers", () => {
  const request = () => ({
    system: "s",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [],
    signal: AbortSignal.timeout(5000),
  });
  it("keeps the default max tokens for providers that ignore effort", async () => {
    const calls = stubFetch(() => chatReply());
    await createProvider({
      provider: "deepseek",
      apiKey: "k",
      effort: "max",
    }).complete(request());
    expect(JSON.stringify(calls[0]?.body)).toContain("8192");
    expect(JSON.stringify(calls[0]?.body)).not.toContain("32000");
  });
  it("times out hung local requests by default", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      ),
    );
    const pending = createProvider({
      provider: "ollama",
      model: "m",
      maxRetries: 0,
    }).complete({ ...request(), signal: new AbortController().signal });
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(121_000);
    await assertion;
  });
  it("falls back on connection errors without replaying metadata", async () => {
    const bodies: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init: RequestInit) => {
        bodies.push(init.body as string);
        if (++call === 1)
          return Promise.reject(
            new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
          );
        return Promise.resolve(claudeReply());
      }),
    );
    const turn = {
      role: "assistant" as const,
      content: "earlier",
      toolCalls: [],
      providerMetadata: {
        provider: "anthropic",
        data: {
          contentBlocks: [
            { type: "thinking", thinking: "t", signature: "SIG" },
            { type: "text", text: "earlier" },
          ],
        },
      },
    };
    await createProvider({
      provider: "anthropic",
      apiKey: "k",
      fallbackModel: "small",
      maxRetries: 0,
    }).complete({
      ...request(),
      messages: [turn, { role: "user", content: "hi" }],
    });
    expect(bodies[0]).toContain("SIG");
    expect(bodies[1]).not.toContain("SIG");
  });
});
