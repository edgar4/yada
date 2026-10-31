import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFakeProvider, readTool, run } from "../src/index.js";
import type {
  AgentEvent,
  ProviderResult,
  RunCheckpoint,
} from "../src/index.js";
const answer: ProviderResult = {
  content: "Done",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 2, outputTokens: 3 },
};
const invocation: ProviderResult = {
  content: "",
  toolCalls: [{ id: "1", name: "lookup", args: { id: "a" } }],
  finishReason: "tool_calls",
};
function setup(results: ProviderResult[] = [invocation, answer]) {
  const execute = vi.fn(() => Promise.resolve("secret-value"));
  const tool = readTool({
    name: "lookup",
    description: "Lookup",
    input: z.strictObject({ id: z.string() }),
    authorize: () => Promise.resolve(true),
    execute,
  });
  const provider = createFakeProvider(
    (_request, call) => results[call - 1] ?? answer,
  );
  const options = {
    provider,
    tools: [tool],
    identity: { actorId: "actor", tenantId: "tenant" },
    input: "Find a",
    system: "Help",
    signal: new AbortController().signal,
  };
  return { execute, provider, options };
}
describe("run hooks", () => {
  it("edits the model request for one call without touching the checkpoint", async () => {
    const s = setup();
    const saved: RunCheckpoint[] = [];
    const afterModel = vi.fn();
    await run({
      ...s.options,
      persist: (checkpoint) => {
        saved.push(checkpoint);
        return Promise.resolve();
      },
      hooks: {
        beforeModel: (request) => ({
          ...request,
          system: "Edited",
          tools: [],
        }),
        afterModel,
      },
    });
    expect(s.provider.requests.map((request) => request.system)).toEqual([
      "Edited",
      "Edited",
    ]);
    expect(s.provider.requests[0]?.tools).toEqual([]);
    expect(afterModel).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(saved)).not.toContain("Edited");
  });
  it("denies a tool call with an error result and skips execution", async () => {
    const s = setup([
      invocation,
      { ...invocation, toolCalls: [{ id: "2", name: "lookup", args: {} }] },
      answer,
    ]);
    const beforeTool = vi.fn(() => ({ deny: "Not today" }));
    const result = await run({ ...s.options, hooks: { beforeTool } });
    expect(result).toEqual({ status: "completed", text: "Done" });
    expect(s.execute).not.toHaveBeenCalled();
    expect(beforeTool).toHaveBeenCalledWith(
      { id: "1", name: "lookup", args: { id: "a" } },
      s.options.tools[0],
    );
    expect(s.provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: JSON.stringify({ error: "denied", message: "Not today" }),
    });
  });
  it("replaces tool output with afterTool", async () => {
    const s = setup();
    await run({
      ...s.options,
      hooks: {
        afterTool: (_call, content) => content.replace("secret", "[x]"),
      },
    });
    expect(s.provider.requests[1]?.messages.at(-1)).toMatchObject({
      content: "[x]-value",
    });
  });
  it("emits events in order with usage", async () => {
    const s = setup();
    const events: AgentEvent[] = [];
    await run({
      ...s.options,
      hooks: { onEvent: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.map((event) => event.type)).toEqual([
      "round_started",
      "model_finished",
      "tool_started",
      "tool_finished",
      "round_started",
      "model_finished",
      "run_finished",
    ]);
    expect(events.at(-2)).toMatchObject({ usage: answer.usage });
    expect(events.at(-1)).toEqual({
      type: "run_finished",
      result: { status: "completed", text: "Done" },
    });
  });
  it("ignores onEvent failures but fails the run on other hook errors", async () => {
    const s = setup();
    expect(
      await run({
        ...s.options,
        hooks: {
          onEvent: () => {
            throw new Error("boom");
          },
        },
      }),
    ).toEqual({ status: "completed", text: "Done" });
    const t = setup();
    expect(
      await run({
        ...t.options,
        hooks: {
          afterModel: () => {
            throw new Error("boom");
          },
        },
      }),
    ).toEqual({ status: "failed", code: "dependency_failed" });
    const u = setup();
    expect(
      await run({
        ...u.options,
        hooks: { beforeTool: () => Promise.reject(new Error("boom")) },
      }),
    ).toEqual({ status: "failed", code: "dependency_failed" });
  });
  it("applies hooks when resuming from a checkpoint", async () => {
    const s = setup();
    const saved: RunCheckpoint[] = [];
    await run({
      ...s.options,
      persist: (checkpoint) => {
        saved.push(checkpoint);
        return Promise.resolve();
      },
    });
    const checkpoint = saved.find(
      (item) => item.pending.length && !item.outcome,
    );
    if (!checkpoint) throw new Error("no checkpoint");
    const t = setup([answer]);
    const beforeTool = vi.fn(() => ({ deny: "no" }));
    const afterTool = vi.fn((_call: unknown, content: string) => content);
    await run({ ...t.options, checkpoint, hooks: { beforeTool, afterTool } });
    expect(beforeTool).toHaveBeenCalledTimes(1);
    expect(afterTool).toHaveBeenCalledTimes(1);
    expect(t.execute).not.toHaveBeenCalled();
  });
  it("reads runtime numbers from limits", async () => {
    const s = setup([invocation, answer]);
    await run({ ...s.options, limits: { maxToolOutput: 4 } });
    expect(s.provider.requests[1]?.messages.at(-1)).toMatchObject({
      content: "secr…[truncated 8 chars]",
    });
    const t = setup([invocation, invocation, invocation]);
    expect(await run({ ...t.options, limits: { maxRounds: 1 } })).toEqual({
      status: "failed",
      code: "limit",
    });
  });
});
