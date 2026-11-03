import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentTool,
  createFakeProvider,
  memoryTools,
  readTool,
  run,
} from "../src/index.js";
import type {
  AgentEvent,
  ProviderResult,
  RunCheckpoint,
  Turn,
} from "../src/index.js";
import { compactOldest } from "../src/core/limits.js";
import { runTurns } from "../src/core/runtime.js";
const identity = { actorId: "a", tenantId: "t" };
const say = (content: string, usage?: ProviderResult["usage"]) =>
  ({
    content,
    toolCalls: [],
    finishReason: "stop",
    ...(usage ? { usage } : {}),
  }) as ProviderResult;
const calls = (names: string[], usage?: ProviderResult["usage"]) =>
  ({
    content: "",
    toolCalls: names.map((name, i) => ({
      id: `c${String(i)}`,
      name,
      args: name === "helper" ? { task: "t" } : {},
    })),
    finishReason: "tool_calls",
    ...(usage ? { usage } : {}),
  }) as ProviderResult;
const tool = (
  name: string,
  execute: (signal: AbortSignal) => Promise<string>,
  timeoutMs?: number,
) =>
  readTool({
    name,
    description: name,
    input: z.strictObject({}),
    authorize: () => Promise.resolve(true),
    execute: (_args, _id, signal) => execute(signal),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
const base = {
  identity,
  system: "s",
  input: "go",
  signal: new AbortController().signal,
};
const last = (provider: { requests: { messages: readonly Turn[] }[] }, n = 1) =>
  JSON.stringify(provider.requests[n]?.messages.at(-1));
const hang = (signal: AbortSignal) =>
  new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  });
const image = (size: number) =>
  ({ type: "image", mimeType: "image/png", data: "A".repeat(size) }) as const;

describe("images in context", () => {
  it("counts an image as a fixed estimate", async () => {
    const provider = createFakeProvider(() => say("ok"));
    const result = await run({
      ...base,
      provider,
      tools: [],
      input: [{ type: "text", text: "see" }, image(400_000)],
    });
    expect(result.status).toBe("completed");
  });
  it("omits old images when over budget", () => {
    const messages: Turn[] = [
      { role: "user", content: [image(400)] },
      { role: "assistant", content: "", toolCalls: [] },
    ];
    expect(compactOldest(messages, 1)).toBeGreaterThan(0);
    expect(JSON.stringify(messages[0])).toContain("[image omitted]");
  });
});

describe("summarizing a long run", () => {
  it("summarizes the run's older rounds and keeps input and latest round", async () => {
    const big = tool("big", () => Promise.resolve("x".repeat(400)));
    const summary = createFakeProvider(() => say("S"));
    const provider = createFakeProvider((_r, n) =>
      n < 4 ? calls(["big"]) : say("done"),
    );
    const saved: RunCheckpoint[] = [];
    const result = await run({
      ...base,
      provider,
      tools: [big],
      limits: { maxContextChars: 900 },
      summarize: { provider: summary },
      persist: (checkpoint) => {
        saved.push(checkpoint);
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ status: "completed", text: "done" });
    expect(summary.requests.length).toBeGreaterThan(0);
    const messages = (saved.at(-1) as RunCheckpoint).messages;
    expect(messages[0]).toEqual({ role: "user", content: "go" });
    expect(JSON.stringify(messages[1])).toContain("[summary of earlier");
    expect(runTurns(messages)[0]).toEqual({ role: "user", content: "go" });
  });
  it("sends the summary through hooks and cost reservation", async () => {
    const big = tool("big", () => Promise.resolve("x".repeat(400)));
    const purposes: (string | undefined)[] = [];
    const script = () =>
      createFakeProvider((_r, n) => (n < 3 ? calls(["big"]) : say("done")));
    const options = {
      ...base,
      tools: [big],
      summarize: { provider: createFakeProvider(() => say("S")) },
      hooks: {
        beforeModel: (_request: unknown, call?: { purpose?: "summary" }) => {
          purposes.push(call?.purpose);
          return undefined;
        },
      },
    };
    await run({
      ...options,
      provider: script(),
      limits: { maxContextChars: 900 },
    });
    expect(purposes).toContain("summary");
    const blocked = await run({
      ...options,
      provider: script(),
      limits: {
        maxContextChars: 900,
        maxCostMicros: 250,
        costPerCallMicros: 100,
      },
    });
    expect(blocked).toEqual({ status: "failed", code: "limit" });
  });
});

describe("sub-agents", () => {
  it("inherit parent limits and report usage to the parent", async () => {
    const loop = tool("loop", () => Promise.resolve("x"));
    const sub = createFakeProvider(() =>
      calls(["loop"], { inputTokens: 2, outputTokens: 1 }),
    );
    const helper = agentTool({
      name: "helper",
      description: "d",
      system: "s",
      provider: sub,
      tools: [loop],
    });
    const provider = createFakeProvider((_r, n) =>
      n === 1
        ? calls(["helper"])
        : say("done", { inputTokens: 1, outputTokens: 1 }),
    );
    const saved: RunCheckpoint[] = [];
    await run({
      ...base,
      provider,
      tools: [helper],
      limits: { maxRounds: 2 },
      persist: (checkpoint) => {
        saved.push(checkpoint);
        return Promise.resolve();
      },
    });
    expect(sub.requests).toHaveLength(2);
    expect(last(provider)).toContain("limit");
    expect(saved.at(-1)?.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });
});

describe("errors and timeouts", () => {
  it("adds a cause to failed tool events and dependency failures", async () => {
    const boom = tool("boom", () =>
      Promise.reject(new Error("secret " + "k".repeat(40))),
    );
    const events: AgentEvent[] = [];
    const provider = createFakeProvider(() => calls(["boom"]));
    const result = await run({
      ...base,
      provider,
      tools: [boom],
      hooks: {
        onEvent: (event) => {
          events.push(event);
          return undefined;
        },
      },
    });
    expect(result).toEqual({ status: "failed", code: "dependency_failed" });
    const finished = events.find((e) => e.type === "tool_finished");
    expect(finished).toMatchObject({ cause: "Error: secret [redacted]" });
    expect(last(provider)).not.toContain("secret");
    expect(events.at(-1)).toMatchObject({
      type: "run_finished",
      cause: "Error: secret [redacted]",
    });
    const broken = createFakeProvider(() => Promise.reject(new Error("down")));
    const seen: AgentEvent[] = [];
    await run({
      ...base,
      provider: broken,
      tools: [],
      hooks: {
        onEvent: (event) => {
          seen.push(event);
          return undefined;
        },
      },
    });
    expect(seen.at(-1)).toMatchObject({ cause: "Error: down" });
  });
  it("times out a tool and tells the model", async () => {
    const slow = tool("slow", hang);
    const provider = createFakeProvider((_r, n) =>
      n === 1 ? calls(["slow"]) : say("ok"),
    );
    const result = await run({
      ...base,
      provider,
      tools: [slow],
      limits: { toolTimeoutMs: 20 },
    });
    expect(result.status).toBe("completed");
    expect(last(provider)).toContain("timeout");
  });
  it("lets a tool override the timeout", async () => {
    const quick = tool("quick", hang, 10);
    const provider = createFakeProvider((_r, n) =>
      n === 1 ? calls(["quick"]) : say("ok"),
    );
    await run({ ...base, provider, tools: [quick] });
    expect(last(provider)).toContain("timeout");
  });
  it("fails the run at maxDurationMs", async () => {
    const provider = createFakeProvider(() => calls(["slow"]));
    const result = await run({
      ...base,
      provider,
      tools: [tool("slow", hang)],
      limits: { maxDurationMs: 20 },
    });
    expect(result).toEqual({ status: "failed", code: "timeout" });
  });
});

describe("structured output", () => {
  const output = z.object({ n: z.number() });
  it("returns parsed data and retries with the validation error", async () => {
    const provider = createFakeProvider((_r, n) =>
      say(n === 1 ? '{"n":"x"}' : '```json\n{"n":2}\n```'),
    );
    const result = await run({ ...base, provider, tools: [], output });
    expect(result).toMatchObject({ status: "completed", data: { n: 2 } });
    expect(provider.requests[0]?.system).toContain('"n"');
    expect(last(provider)).toContain("n:");
  });
  it("fails after two retries", async () => {
    const provider = createFakeProvider(() => say("nope"));
    const result = await run({ ...base, provider, tools: [], output });
    expect(result).toEqual({ status: "failed", code: "invalid_response" });
    expect(provider.requests).toHaveLength(3);
  });
});

describe("runtime behavior", () => {
  it("counts failed rounds, so the model sees parallel failures", async () => {
    const bad = tool("bad", () => Promise.reject(new Error("x")));
    const provider = createFakeProvider((_r, n) =>
      n === 1 ? calls(["bad", "bad", "bad"]) : say("seen"),
    );
    const result = await run({ ...base, provider, tools: [bad] });
    expect(result).toEqual({ status: "completed", text: "seen" });
  });
  it("reports steering left unconsumed at maxRounds", async () => {
    const events: AgentEvent[] = [];
    let drained = 0;
    const result = await run({
      ...base,
      provider: createFakeProvider(() => say("end")),
      tools: [],
      maxRounds: 1,
      drainSteering: () =>
        Promise.resolve(drained++ ? [{ id: "m", content: "more" }] : []),
      hooks: {
        onEvent: (event) => {
          events.push(event);
          return undefined;
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(events).toContainEqual({ type: "steering_unconsumed", count: 1 });
  });
  it("delivers events in order and before run returns", async () => {
    const seen: string[] = [];
    await run({
      ...base,
      provider: createFakeProvider(() => say("end")),
      tools: [],
      hooks: {
        onEvent: async (event) => {
          if (event.type === "round_started")
            await new Promise((resolve) => setTimeout(resolve, 20));
          seen.push(event.type);
        },
      },
    });
    expect(seen).toEqual(["round_started", "model_finished", "run_finished"]);
  });
  it("persists usage right after the model call", async () => {
    const saved: RunCheckpoint[] = [];
    await run({
      ...base,
      provider: createFakeProvider(() =>
        say("end", { inputTokens: 3, outputTokens: 1 }),
      ),
      tools: [],
      persist: (checkpoint) => {
        saved.push(checkpoint);
        return Promise.resolve();
      },
    });
    const withUsage = saved.find((c) => c.usage);
    expect(withUsage?.messages).toHaveLength(1);
  });
  it("caps memory_save text", () => {
    const save = memoryTools({} as never).find(
      (t) => t.spec.name === "memory_save",
    );
    const text = (
      save?.spec.parameters as { properties: { text: { maxLength: number } } }
    ).properties.text;
    expect(text.maxLength).toBe(4000);
  });
});
