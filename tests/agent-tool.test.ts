import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentTool,
  createFakeProvider,
  readTool,
  run,
  writeTool,
} from "../src/index.js";
import type { ProviderResult } from "../src/index.js";
const identity = { actorId: "a", tenantId: "t" };
const say = (content: string): ProviderResult => ({
  content,
  toolCalls: [],
  finishReason: "stop",
});
const call = (name: string, args: unknown): ProviderResult => ({
  content: "",
  toolCalls: [{ id: "c1", name, args }],
  finishReason: "tool_calls",
});
const base = { description: "d", system: "s" };
const parent = (tool: ReturnType<typeof agentTool>, signal?: AbortSignal) => {
  const provider = createFakeProvider((_r, n) =>
    n === 1 ? call(tool.spec.name, { task: "go" }) : say("parent done"),
  );
  return {
    provider,
    result: run({
      provider,
      tools: [tool],
      identity,
      input: "x",
      system: "p",
      signal: signal ?? new AbortController().signal,
    }),
  };
};
const toolContent = (p: { requests: { messages: readonly unknown[] }[] }) =>
  JSON.stringify(p.requests[1]?.messages.at(-1));
describe("agentTool", () => {
  it("runs a nested agent and returns its text", async () => {
    const sub = createFakeProvider(() => say("sub answer"));
    const tool = agentTool({ ...base, name: "sub", provider: sub, tools: [] });
    const { provider, result } = parent(tool);
    expect(await result).toEqual({ status: "completed", text: "parent done" });
    expect(sub.requests[0]?.messages[0]).toEqual({
      role: "user",
      content: "go",
    });
    expect(toolContent(provider)).toContain("sub answer");
  });
  it("maps sub-agent failure to a safe tool result", async () => {
    const sub = createFakeProvider(() => ({
      ...say(""),
      finishReason: "refusal",
    }));
    const tool = agentTool({ ...base, name: "sub", provider: sub, tools: [] });
    const { provider, result } = parent(tool);
    expect((await result).status).toBe("completed");
    expect(toolContent(provider)).toContain("agent_failed");
    expect(toolContent(provider)).toContain("refused");
  });
  it("rejects invalid input", async () => {
    const sub = createFakeProvider(() => say("x"));
    const tool = agentTool({ ...base, name: "sub", provider: sub, tools: [] });
    const provider = createFakeProvider((_r, n) =>
      n === 1 ? call("sub", {}) : say("ok"),
    );
    await run({
      provider,
      tools: [tool],
      identity,
      input: "x",
      system: "p",
      signal: new AbortController().signal,
    });
    expect(sub.requests).toHaveLength(0);
    expect(toolContent(provider)).toContain("invalid_arguments");
  });
  it("propagates cancellation", async () => {
    const controller = new AbortController();
    const sub = createFakeProvider(
      (request) =>
        new Promise<ProviderResult>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
          controller.abort();
        }),
    );
    const tool = agentTool({ ...base, name: "sub", provider: sub, tools: [] });
    const { result } = parent(tool, controller.signal);
    expect(await result).toEqual({ status: "cancelled" });
  });
  it("rejects write tools", () => {
    const write = writeTool({
      name: "w",
      description: "w",
      version: "1",
      input: z.strictObject({}),
      authorize: () => Promise.resolve(true),
      prepare: () => Promise.reject(new Error("unused")),
      execute: () => Promise.resolve("ok"),
    });
    expect(() =>
      agentTool({
        ...base,
        name: "sub",
        provider: createFakeProvider(() => say("x")),
        tools: [write],
      }),
    ).toThrow("write");
  });
  it("limits nesting depth to 2", () => {
    const leafProvider = createFakeProvider(() => say("leaf"));
    const leaf = agentTool({
      ...base,
      name: "leaf",
      provider: leafProvider,
      tools: [],
    });
    const midProvider = createFakeProvider((_r, n) =>
      n === 1 ? call("leaf", { task: "t" }) : say("mid"),
    );
    const mid = agentTool({
      ...base,
      name: "mid",
      provider: midProvider,
      tools: [leaf],
    });
    expect(mid.spec.name).toBe("mid");
    expect(() =>
      agentTool({
        ...base,
        name: "top",
        provider: createFakeProvider(() => say("x")),
        tools: [mid],
      }),
    ).toThrow("deeply");
    const plain = readTool({
      name: "p",
      description: "p",
      input: z.strictObject({}),
      authorize: () => Promise.resolve(true),
      execute: () => Promise.resolve("p"),
    });
    expect(
      agentTool({
        ...base,
        name: "ok",
        provider: leafProvider,
        tools: [plain],
      }),
    ).toBeDefined();
  });
});
