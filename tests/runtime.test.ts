import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFakeProvider, readTool, run } from "../src/index.js";
import type { ProviderResult, RunCheckpoint } from "../src/index.js";
const answer: ProviderResult = {
  content: "Done",
  toolCalls: [],
  finishReason: "stop",
};
const invocation: ProviderResult = {
  content: "",
  toolCalls: [{ id: "1", name: "lookup", args: { id: "a" } }],
  finishReason: "tool_calls",
};
function setup(results: ProviderResult[] = [invocation, answer]) {
  const execute = vi.fn(() => Promise.resolve("Available"));
  const authorize = vi.fn(() => Promise.resolve(true));
  const tool = readTool({
    name: "lookup",
    description: "Lookup",
    input: z.strictObject({ id: z.string() }),
    authorize,
    execute,
  });
  const provider = createFakeProvider(
    (_request, call) => results[call - 1] ?? answer,
  );
  const controller = new AbortController();
  const options = {
    provider,
    tools: [tool],
    identity: { actorId: "actor", tenantId: "tenant" },
    input: "Find a",
    system: "Help",
    signal: controller.signal,
  };
  return { execute, authorize, tool, provider, controller, options };
}
describe("standalone runtime", () => {
  it("executes a typed tool and returns its result to the provider", async () => {
    const s = setup();
    expect(await run(s.options)).toEqual({ status: "completed", text: "Done" });
    expect(s.execute).toHaveBeenCalledWith(
      { id: "a" },
      s.options.identity,
      s.options.signal,
    );
    expect(s.provider.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      name: "lookup",
      toolCallId: "1",
      content: "Available",
    });
    expect(s.provider.requests[0]?.messages).toHaveLength(1);
  });
  it("supports chat without tools", async () => {
    const s = setup([answer]);
    expect(await run({ ...s.options, tools: [] })).toEqual({
      status: "completed",
      text: "Done",
    });
  });
  it("hides unauthorized tools", async () => {
    const s = setup();
    s.authorize.mockResolvedValue(false);
    expect(await run(s.options)).toEqual({ status: "completed", text: "Done" });
    expect(
      JSON.parse(s.provider.requests[1]?.messages.at(-1)?.content ?? ""),
    ).toMatchObject({ error: "unknown_tool" });
    expect(s.provider.requests[0]?.tools).toEqual([]);
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("rechecks revoked access", async () => {
    const s = setup();
    s.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await run(s.options)).toEqual({
      status: "failed",
      code: "tool_denied",
    });
    expect(s.execute).not.toHaveBeenCalled();
  });
  it.each([{ id: 1 }, { id: "a", tenantId: "other" }, null])(
    "returns invalid arguments %j to the model",
    async (args) => {
      const s = setup([
        { ...invocation, toolCalls: [{ id: "1", name: "lookup", args }] },
      ]);
      expect(await run(s.options)).toEqual({
        status: "completed",
        text: "Done",
      });
      const message = s.provider.requests[1]?.messages.at(-1);
      expect(message).toMatchObject({ role: "tool", toolCallId: "1" });
      expect(JSON.parse(message?.content ?? "")).toMatchObject({
        error: "invalid_arguments",
      });
      expect(message?.content).not.toContain("other");
      expect(s.execute).not.toHaveBeenCalled();
    },
  );
  it("returns unknown tools to the model", async () => {
    const s = setup([
      { ...invocation, toolCalls: [{ id: "1", name: "nope", args: {} }] },
    ]);
    expect(await run(s.options)).toEqual({ status: "completed", text: "Done" });
    expect(
      JSON.parse(s.provider.requests[1]?.messages.at(-1)?.content ?? ""),
    ).toMatchObject({ error: "unknown_tool" });
  });
  it("returns a generic message for tool failures", async () => {
    const s = setup();
    s.execute.mockRejectedValue(new Error("secret"));
    expect(await run(s.options)).toEqual({ status: "completed", text: "Done" });
    const content = s.provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(JSON.parse(content)).toMatchObject({ error: "tool_failed" });
    expect(content).not.toContain("secret");
  });
  it("fails after three consecutive tool failures", async () => {
    const s = setup(
      Array.from({ length: 5 }, (_, index): ProviderResult => ({
        ...invocation,
        toolCalls: [{ id: String(index), name: "lookup", args: { id: "a" } }],
      })),
    );
    s.execute.mockRejectedValue(new Error("x"));
    expect(await run(s.options)).toEqual({
      status: "failed",
      code: "dependency_failed",
    });
    expect(s.provider.requests).toHaveLength(3);
  });
  it("resets the failure count after a success", async () => {
    const s = setup(
      Array.from({ length: 5 }, (_, index): ProviderResult => ({
        ...invocation,
        toolCalls: [{ id: String(index), name: "lookup", args: { id: "a" } }],
      })).concat([answer]),
    );
    s.execute
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x"));
    expect(await run({ ...s.options, maxRounds: 10 })).toEqual({
      status: "completed",
      text: "Done",
    });
  });
  it("resumes a pending failed call with a persisted failure count", async () => {
    const s = setup();
    s.execute.mockRejectedValue(new Error("x"));
    const saved: RunCheckpoint[] = [];
    await run({
      ...s.options,
      persist: (checkpoint) => {
        saved.push(checkpoint);
        return Promise.resolve();
      },
    });
    const resume = saved.find((item) => item.pending.length);
    expect(resume).toBeDefined();
    const again = setup([answer]);
    again.execute.mockRejectedValue(new Error("x"));
    expect(
      await run({
        ...again.options,
        checkpoint: { ...(resume as RunCheckpoint), failures: 2 },
      }),
    ).toEqual({ status: "failed", code: "dependency_failed" });
    expect(again.provider.requests).toHaveLength(0);
  });
  it("keeps cancellation and revoked access terminal over tool errors", async () => {
    const s = setup();
    s.execute.mockImplementation(() => {
      s.controller.abort();
      return Promise.reject(new Error("x"));
    });
    expect(await run(s.options)).toEqual({ status: "cancelled" });
  });
  it("rejects duplicate tool registration", async () => {
    const s = setup();
    await expect(
      run({ ...s.options, tools: [s.tool, s.tool] }),
    ).rejects.toThrow("Duplicate");
  });
  it("rejects duplicate call IDs before execution", async () => {
    const s = setup([
      {
        ...invocation,
        toolCalls: [...invocation.toolCalls, ...invocation.toolCalls],
      },
    ]);
    expect(await run(s.options)).toEqual({
      status: "failed",
      code: "invalid_response",
    });
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("enforces call budget before execution", async () => {
    const s = setup([
      {
        ...invocation,
        toolCalls: [
          ...invocation.toolCalls,
          { id: "2", name: "lookup", args: { id: "b" } },
        ],
      },
    ]);
    expect(await run({ ...s.options, maxToolCalls: 1 })).toEqual({
      status: "failed",
      code: "limit",
    });
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("enforces round budget", async () => {
    const s = setup();
    expect(await run({ ...s.options, maxRounds: 1 })).toEqual({
      status: "failed",
      code: "limit",
    });
  });
  it.each([0, -1, 1.5, Infinity])(
    "rejects invalid limits %s",
    async (maxRounds) => {
      await expect(run({ ...setup().options, maxRounds })).rejects.toThrow(
        "Invalid",
      );
    },
  );
  it("cancels before calling dependencies", async () => {
    const s = setup();
    s.controller.abort();
    expect(await run(s.options)).toEqual({ status: "cancelled" });
    expect(s.provider.requests).toHaveLength(0);
  });
  it("cancels after provider completes", async () => {
    const s = setup();
    s.options.provider = createFakeProvider(() => {
      s.controller.abort();
      return invocation;
    });
    expect(await run(s.options)).toEqual({ status: "cancelled" });
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("rejects unsupported tool calling", async () => {
    const s = setup();
    expect(
      await run({
        ...s.options,
        provider: { ...s.provider, capabilities: { toolCalling: false } },
      }),
    ).toEqual({ status: "failed", code: "unsupported" });
  });
  it.each(["length", "other"] as const)(
    "rejects incomplete results %s",
    async (finishReason) => {
      expect(await run(setup([{ ...answer, finishReason }]).options)).toEqual({
        status: "failed",
        code: "invalid_response",
      });
    },
  );
  it("truncates oversized tool output", async () => {
    const s = setup();
    s.execute.mockResolvedValue("x".repeat(32005));
    expect(await run(s.options)).toEqual({ status: "completed", text: "Done" });
    const content = s.provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(content).toBe(`${"x".repeat(32000)}…[truncated 5 chars]`);
  });
  it("completes with earlier assistant text when the final text is empty", async () => {
    const s = setup([
      { ...invocation, content: "Earlier" },
      { ...answer, content: "" },
    ]);
    expect(await run(s.options)).toEqual({
      status: "completed",
      text: "Earlier",
    });
  });
  it("fails empty final text when no assistant text exists", async () => {
    const s = setup([invocation, { ...answer, content: "" }]);
    expect(await run(s.options)).toEqual({
      status: "failed",
      code: "invalid_response",
    });
  });
  it("rewrites call IDs reused across rounds", async () => {
    const s = setup([invocation, invocation, answer]);
    expect(await run(s.options)).toEqual({ status: "completed", text: "Done" });
    const last = s.provider.requests[2]?.messages;
    expect(last?.at(-1)).toMatchObject({ role: "tool", toolCallId: "1-r2" });
    expect(last?.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "1-r2" }],
    });
  });
  it("fails refusals", async () => {
    expect(
      await run(setup([{ ...answer, finishReason: "refusal" }]).options),
    ).toEqual({ status: "failed", code: "refused" });
  });
  it("rejects empty answers", async () => {
    expect(await run(setup([{ ...answer, content: "" }]).options)).toEqual({
      status: "failed",
      code: "invalid_response",
    });
  });
});
