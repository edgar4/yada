import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  composeHooks,
  createFakeProvider,
  readTool,
  run,
  tracingHooks,
  writeTool,
} from "../src/index.js";
import type { ProviderResult, Span, Tracer } from "../src/index.js";
type Recorded = {
  name: string;
  attrs: Record<string, unknown>;
  status?: string;
  ended: boolean;
};
function memoryTracer() {
  const spans: Recorded[] = [];
  const tracer: Tracer = {
    startSpan(name, attributes = {}) {
      const record: Recorded = { name, attrs: { ...attributes }, ended: false };
      spans.push(record);
      const span: Span = {
        setAttribute: (key, value) => {
          record.attrs[key] = value;
        },
        setStatus: ({ code }) => {
          record.status = code;
        },
        end: () => {
          record.ended = true;
        },
      };
      return span;
    },
  };
  return { spans, tracer };
}
const call: ProviderResult = {
  content: "",
  toolCalls: [{ id: "1", name: "lookup", args: { id: "private-arg" } }],
  finishReason: "tool_calls",
  usage: { inputTokens: 10, outputTokens: 5 },
};
const answer: ProviderResult = {
  content: "private-answer",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 20, outputTokens: 7 },
};
const lookup = (execute: () => Promise<string>) =>
  readTool({
    name: "lookup",
    description: "Lookup",
    input: z.strictObject({ id: z.string() }),
    authorize: () => Promise.resolve(true),
    execute,
  });
const base = {
  identity: { actorId: "a", tenantId: "t" },
  input: "private-input",
  system: "Help",
  signal: new AbortController().signal,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
describe("tracing hooks", () => {
  it("records run, model and tool spans without content", async () => {
    const { spans, tracer } = memoryTracer();
    const results = [call, answer];
    await run({
      ...base,
      provider: createFakeProvider((_r, n) => results[n - 1] ?? answer),
      tools: [lookup(() => Promise.resolve("private-output"))],
      hooks: tracingHooks(tracer, { provider: "fake", model: "m1" }),
    });
    await settle();
    expect(spans.map((span) => span.name)).toEqual([
      "yada.run",
      "yada.model",
      "yada.tool",
      "yada.model",
    ]);
    expect(spans.every((span) => span.ended)).toBe(true);
    expect(spans[0]?.attrs).toMatchObject({ "run.status": "completed" });
    expect(spans[1]?.attrs).toMatchObject({
      "model.provider": "fake",
      "model.name": "m1",
      "model.finish_reason": "tool_calls",
      "usage.input_tokens": 10,
      "usage.output_tokens": 5,
    });
    expect(spans[2]?.attrs).toEqual({
      "tool.name": "lookup",
      "tool.effect": "read",
      "tool.outcome": "ok",
    });
    expect(JSON.stringify(spans)).not.toMatch(/private/);
  });
  it("marks failed tools with a category", async () => {
    const { spans, tracer } = memoryTracer();
    const results = [call, answer];
    await run({
      ...base,
      provider: createFakeProvider((_r, n) => results[n - 1] ?? answer),
      tools: [lookup(() => Promise.reject(new Error("private-error")))],
      hooks: tracingHooks(tracer),
    });
    await settle();
    const tool = spans.find((span) => span.name === "yada.tool");
    expect(tool?.attrs["tool.outcome"]).toBe("tool_failed");
    expect(tool?.status).toBe("error");
    expect(tool?.attrs["tool.cause"]).toBe("Error: private-error");
  });
  it("closes an open model span when the run fails", async () => {
    const { spans, tracer } = memoryTracer();
    const result = await run({
      ...base,
      provider: createFakeProvider(() => {
        throw new Error("down");
      }),
      tools: [],
      hooks: tracingHooks(tracer),
    });
    await settle();
    expect(result).toEqual({ status: "failed", code: "dependency_failed" });
    expect(spans.every((span) => span.ended)).toBe(true);
    expect(spans[0]?.attrs["run.code"]).toBe("dependency_failed");
    expect(spans[1]?.status).toBe("error");
  });
});
describe("suspended runs", () => {
  it("ends open spans when the run suspends", async () => {
    const { spans, tracer } = memoryTracer();
    const events: string[] = [];
    const hooks = composeHooks(tracingHooks(tracer), {
      onEvent: (event) => {
        events.push(event.type);
        return undefined;
      },
    });
    const rename = writeTool({
      name: "lookup",
      description: "Rename",
      version: "1",
      input: z.strictObject({ id: z.string() }),
      authorize: () => Promise.resolve(true),
      prepare: () => Promise.resolve({ preview: "p", version: "1" }),
      execute: () => Promise.resolve("done"),
    });
    const result = await run({
      ...base,
      provider: createFakeProvider(() => call),
      tools: [rename],
      executeWrite: () =>
        Promise.resolve({ status: "awaiting_approval", approvalId: "x" }),
      hooks,
    });
    await settle();
    expect(result.status).toBe("awaiting_approval");
    expect(events.filter((type) => type.startsWith("run_"))).toEqual([
      "run_suspended",
    ]);
    expect(spans.map((span) => span.name)).toContain("yada.tool");
    expect(spans.every((span) => span.ended && span.status === "ok")).toBe(
      true,
    );
    expect(spans[0]?.attrs).toMatchObject({
      "run.status": "awaiting_approval",
    });
  });
});
describe("composeHooks", () => {
  it("chains edits and stops on the first denial", async () => {
    const seen: string[] = [];
    const hooks = composeHooks(
      { afterTool: (_c, content) => `${content}1` },
      { afterTool: (_c, content) => `${content}2` },
      { beforeTool: () => ({ deny: "no" }) },
      {
        beforeTool: () => {
          seen.push("late");
          return undefined;
        },
      },
    );
    const tool = lookup(() => Promise.resolve(""));
    const invocation = { id: "1", name: "lookup", args: {} };
    expect(await hooks.afterTool?.(invocation, "x")).toBe("x12");
    expect(await hooks.beforeTool?.(invocation, tool)).toEqual({
      deny: "no",
    });
    expect(seen).toEqual([]);
  });
});
describe("cost from actual usage", () => {
  it("stops once reported usage reaches the budget", async () => {
    const results = [call, call, answer];
    let calls = 0;
    const result = await run({
      ...base,
      provider: createFakeProvider((_r, n) => {
        calls = n;
        return results[n - 1] ?? answer;
      }),
      tools: [lookup(() => Promise.resolve("ok"))],
      limits: {
        maxCostMicros: 20,
        pricing: { inputMicrosPer1k: 1000, outputMicrosPer1k: 1000 },
      },
    });
    expect(result).toEqual({ status: "failed", code: "limit" });
    expect(calls).toBe(2);
  });
  it("prices cached input tokens separately when configured", async () => {
    const cachedCall = {
      ...call,
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 900 },
    };
    const attempt = (cacheReadMicrosPer1k?: number) =>
      run({
        ...base,
        provider: createFakeProvider((_r, n) =>
          n === 1 ? cachedCall : answer,
        ),
        tools: [lookup(() => Promise.resolve("ok"))],
        limits: {
          maxCostMicros: 500,
          pricing: {
            inputMicrosPer1k: 1000,
            outputMicrosPer1k: 1000,
            ...(cacheReadMicrosPer1k === undefined
              ? {}
              : { cacheReadMicrosPer1k }),
          },
        },
      });
    expect((await attempt(100)).status).toBe("completed");
    expect(await attempt()).toEqual({ status: "failed", code: "limit" });
  });
  it("allows runs under the budget and rejects an unpriced limit", async () => {
    const result = await run({
      ...base,
      provider: createFakeProvider(() => answer),
      tools: [],
      limits: {
        maxCostMicros: 1000,
        pricing: { inputMicrosPer1k: 1, outputMicrosPer1k: 1 },
      },
    });
    expect(result.status).toBe("completed");
    await expect(
      run({
        ...base,
        provider: createFakeProvider(() => answer),
        tools: [],
        limits: { maxCostMicros: 5 },
      }),
    ).rejects.toThrow();
  });
});
