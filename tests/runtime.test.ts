import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFakeProvider, readTool, run } from "../src/index.js";
import type { ProviderResult } from "../src/index.js";
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
    expect(await run(s.options)).toEqual({
      status: "failed",
      code: "tool_denied",
    });
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
    "rejects invalid arguments %j",
    async (args) => {
      const s = setup([
        { ...invocation, toolCalls: [{ id: "1", name: "lookup", args }] },
      ]);
      expect(await run(s.options)).toEqual({
        status: "failed",
        code: "dependency_failed",
      });
      expect(s.execute).not.toHaveBeenCalled();
    },
  );
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
  it("does not expose dependency errors", async () => {
    const s = setup();
    s.execute.mockRejectedValue(new Error("secret"));
    expect(await run(s.options)).toEqual({
      status: "failed",
      code: "dependency_failed",
    });
  });
  it("bounds tool output", async () => {
    const s = setup();
    s.execute.mockResolvedValue("x".repeat(32001));
    expect(await run(s.options)).toEqual({
      status: "failed",
      code: "invalid_response",
    });
  });
  it("rejects empty answers", async () => {
    expect(await run(setup([{ ...answer, content: "" }]).options)).toEqual({
      status: "failed",
      code: "invalid_response",
    });
  });
});
