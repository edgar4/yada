import { expect, it, vi } from "vitest";
import { z } from "zod";
import { run, readTool, createFakeProvider } from "../src/index.js";
import { CheckpointError, type RunCheckpoint } from "../src/core/checkpoint.js";
const pending: RunCheckpoint = {
  version: 1,
  messages: [
    { role: "user", content: "Lookup" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "lookup", args: {} }],
      providerMetadata: { provider: "fake", data: { signature: "retained" } },
    },
  ],
  pending: [{ id: "1", name: "lookup", args: {} }],
  rounds: 1,
  calls: 0,
};
function setup() {
  const execute = vi.fn(() => Promise.resolve("Found"));
  const authorize = vi.fn(() => Promise.resolve(true));
  const provider = createFakeProvider(() => ({
    content: "Done",
    toolCalls: [],
    finishReason: "stop",
  }));
  const options = {
    provider,
    tools: [
      readTool({
        name: "lookup",
        description: "Lookup",
        input: z.strictObject({}),
        execute,
        authorize,
      }),
    ],
    identity: { actorId: "actor", tenantId: "tenant" },
    input: "Lookup",
    system: "Help",
    signal: new AbortController().signal,
  };
  return { execute, authorize, provider, options };
}
it("resumes pending calls before the model and retains provider metadata", async () => {
  const s = setup();
  expect(await run({ ...s.options, checkpoint: pending })).toEqual({
    status: "completed",
    text: "Done",
  });
  expect(s.execute).toHaveBeenCalledOnce();
  expect(s.provider.requests[0]?.messages[1]).toEqual(pending.messages[1]);
  expect(s.provider.requests[0]?.messages.at(-1)).toMatchObject({
    role: "tool",
    content: "Found",
  });
});
it("rechecks authorization on recovery", async () => {
  const s = setup();
  s.authorize.mockResolvedValue(false);
  expect(await run({ ...s.options, checkpoint: pending })).toEqual({
    status: "failed",
    code: "tool_denied",
  });
  expect(s.execute).not.toHaveBeenCalled();
});
it("retains consumed budgets and call IDs on recovery", async () => {
  const s = setup();
  expect(
    await run({
      ...s.options,
      checkpoint: { ...pending, pending: [], rounds: 8 },
    }),
  ).toEqual({ status: "failed", code: "limit" });
  expect(s.provider.requests).toHaveLength(0);
  const provider = createFakeProvider(() => ({
    content: "",
    toolCalls: pending.pending,
    finishReason: "tool_calls",
  }));
  expect(
    await run({
      ...s.options,
      provider,
      checkpoint: { ...pending, pending: [] },
    }),
  ).toEqual({ status: "failed", code: "invalid_response" });
});
it("does not call dependencies when the attempt checkpoint fails", async () => {
  const s = setup();
  const persist = vi.fn(() => Promise.reject(new Error("Database offline")));
  await expect(run({ ...s.options, persist })).rejects.toBeInstanceOf(
    CheckpointError,
  );
  expect(persist).toHaveBeenCalledOnce();
  expect(s.provider.requests).toHaveLength(0);
  expect(s.execute).not.toHaveBeenCalled();
});
it("checkpoints model decisions before executing tools", async () => {
  const s = setup();
  const provider = createFakeProvider(() => ({
    content: "",
    toolCalls: pending.pending,
    finishReason: "tool_calls",
  }));
  const persist = vi.fn((state: RunCheckpoint) =>
    state.pending.length
      ? Promise.reject(new Error("Database offline"))
      : Promise.resolve(),
  );
  await expect(run({ ...s.options, provider, persist })).rejects.toBeInstanceOf(
    CheckpointError,
  );
  expect(s.execute).not.toHaveBeenCalled();
});
it("does not report success when the terminal checkpoint fails", async () => {
  const s = setup();
  await expect(
    run({
      ...s.options,
      persist: (state) =>
        state.outcome
          ? Promise.reject(new Error("Database offline"))
          : Promise.resolve(),
    }),
  ).rejects.toBeInstanceOf(CheckpointError);
});
it("returns terminal checkpoints without dependencies", async () => {
  const s = setup();
  expect(
    await run({
      ...s.options,
      checkpoint: { ...pending, outcome: { status: "cancelled" } },
    }),
  ).toEqual({ status: "cancelled" });
  expect(s.authorize).not.toHaveBeenCalled();
  expect(s.provider.requests).toHaveLength(0);
});
