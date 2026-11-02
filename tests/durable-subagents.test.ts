import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { drivers, storageFixture } from "./helpers/storage.js";
import { agentTool } from "../src/core/agent-tool.js";
import { readTool } from "../src/core/tool.js";
import { writeTool } from "../src/core/action.js";
import { CheckpointError, type RunCheckpoint } from "../src/core/checkpoint.js";
import { actionExecutor } from "../src/service/actions.js";
import { operationId } from "../src/storage/actions.js";
import { runDurable } from "../src/storage/durable-run.js";
import { subRunId, type RunStore } from "../src/storage/runs.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import type { ProviderResult } from "../src/index.js";
const say = (content: string, tokens = 1): ProviderResult => ({
  content,
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: tokens, outputTokens: tokens },
});
const call = (id: string, name: string, args: unknown, tokens = 1) => ({
  content: "",
  toolCalls: [{ id, name, args }],
  finishReason: "tool_calls" as const,
  usage: { inputTokens: tokens, outputTokens: tokens },
});
function fixture() {
  const execute = vi.fn(() => Promise.resolve("renamed"));
  const write = writeTool({
    name: "rename",
    description: "Rename",
    version: "1",
    input: z.strictObject({}),
    authorize: () => Promise.resolve(true),
    prepare: () => Promise.resolve({ preview: "Rename", version: "1" }),
    execute,
  });
  const read = vi.fn(() => Promise.resolve("data"));
  const lookup = readTool({
    name: "lookup",
    description: "Lookup",
    input: z.strictObject({}),
    authorize: () => Promise.resolve(true),
    execute: read,
  });
  return { execute, write, read, lookup };
}
const childProvider = (tool: string, tokens = 10) =>
  createFakeProvider((_r, n) =>
    n === 1 ? call("w1", tool, {}, tokens) : say("child done", tokens),
  );
const parentProvider = () =>
  createFakeProvider((_r, n) =>
    n === 1 ? call("c1", "sub", { task: "go" }) : say("parent done"),
  );
const agent = (
  provider: ReturnType<typeof createFakeProvider>,
  tools: Parameters<typeof agentTool>[0]["tools"],
) => agentTool({ name: "sub", description: "d", system: "s", provider, tools });
const failSave = (
  runs: RunStore,
  id: string,
  when: (checkpoint: RunCheckpoint) => boolean,
) =>
  ({
    ...runs,
    save: (...args: Parameters<RunStore["save"]>) =>
      args[1] === id && when(args[3])
        ? Promise.reject(new CheckpointError())
        : runs.save(...args),
  }) satisfies RunStore;
for (const driver of drivers)
  describe(`${driver} durable sub-agents`, () => {
    async function setup() {
      const s = await storageFixture(driver);
      const t = fixture();
      const provider = parentProvider();
      const options = (
        tool: ReturnType<typeof agentTool>,
        extra: Partial<Parameters<typeof runDurable>[0]> = {},
      ) => ({
        provider,
        tools: [tool],
        identity: s.identity,
        input: "x",
        system: "p",
        runId: "p",
        profileId: "v1",
        leaseMs: 1000,
        store: s.storage.runs,
        signal: AbortSignal.timeout(5000),
        executeWrite: actionExecutor(s.storage.actions, s.identity, "p"),
        ...extra,
      });
      return { s, t, options };
    }
    it("suspends the parent on a child approval and resumes the child once", async () => {
      const { s, t, options } = await setup();
      const sub = childProvider("rename");
      const opts = options(agent(sub, [t.write]));
      const id = operationId(s.identity, "p", "sub:c1:w1");
      expect(await runDurable(opts)).toEqual({
        status: "awaiting_approval",
        approvalId: id,
      });
      expect((await s.storage.actions.load(s.identity, id))?.runId).toBe("p");
      await s.storage.actions.decide(s.identity, id, true);
      expect(await runDurable(opts)).toEqual({
        status: "completed",
        text: "parent done",
      });
      expect(t.execute).toHaveBeenCalledOnce();
      expect(sub.requests).toHaveLength(2);
      const saved = await s.storage.runs.load(s.identity, "p");
      expect(saved?.checkpoint?.usage).toEqual({
        inputTokens: 22,
        outputTokens: 22,
      });
    });
    it("does not re-run a child that finished before the parent saved", async () => {
      const { s, t, options } = await setup();
      const sub = childProvider("lookup");
      const tool = agent(sub, [t.lookup]);
      await expect(
        runDurable(
          options(tool, {
            leaseMs: 100,
            store: failSave(s.storage.runs, "p", (c) =>
              c.messages.some((m) => m.role === "tool"),
            ),
          }),
        ),
      ).rejects.toThrow();
      await delay(150);
      const failing = failSave(s.storage.runs, "p", () => false);
      expect(await runDurable(options(tool, { store: failing }))).toEqual({
        status: "completed",
        text: "parent done",
      });
      expect(sub.requests).toHaveLength(2);
      expect(t.read).toHaveBeenCalledOnce();
    });
    it("resumes a crashed child from its checkpoint", async () => {
      const { s, t, options } = await setup();
      const sub = childProvider("lookup");
      const tool = agent(sub, [t.lookup]);
      const childId = subRunId("p", "c1");
      await expect(
        runDurable(
          options(tool, {
            leaseMs: 100,
            store: failSave(s.storage.runs, childId, (c) => c.rounds === 2),
          }),
        ),
      ).rejects.toBeInstanceOf(CheckpointError);
      await delay(150);
      expect(await runDurable(options(tool))).toEqual({
        status: "completed",
        text: "parent done",
      });
      expect(t.read).toHaveBeenCalledOnce();
    });
    it("propagates cancellation to the child", async () => {
      const { s, t, options } = await setup();
      const controller = new AbortController();
      let childSignal: AbortSignal | undefined;
      const sub = createFakeProvider(
        (request) =>
          new Promise<ProviderResult>((_resolve, reject) => {
            childSignal = request.signal;
            request.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
            controller.abort();
          }),
      );
      const result = await runDurable(
        options(agent(sub, [t.lookup]), { signal: controller.signal }),
      );
      expect(result).toEqual({ status: "cancelled" });
      expect(childSignal?.aborted).toBe(true);
      const child = await s.storage.runs.load(s.identity, subRunId("p", "c1"));
      expect(child?.checkpoint?.outcome).toEqual({ status: "cancelled" });
    });
    it("erases child runs and actions with the conversation", async () => {
      const { s, t } = await setup();
      const sub = childProvider("rename");
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "run",
        input: "go",
        profileId: "v1",
      });
      const worker = createWorker({
        storage: s.storage,
        profiles: {
          v1: {
            provider: parentProvider(),
            tools: [agent(sub, [t.write])],
            system: "p",
          },
        },
      });
      await worker.tick();
      const runId = JSON.stringify(["chat", "run"]);
      const childId = subRunId(runId, "c1");
      const actionId = operationId(s.identity, runId, "sub:c1:w1");
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "run"))?.status,
      ).toBe("awaiting_approval");
      expect(await s.storage.runs.load(s.identity, childId)).toBeDefined();
      await s.storage.actions.decide(s.identity, actionId, true);
      await s.storage.jobs.update(s.identity, "chat", "run", {
        type: "queued",
      });
      await worker.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "run"))?.status,
      ).toBe("completed");
      expect(t.execute).toHaveBeenCalledOnce();
      await s.storage.retention.eraseConversation(s.identity, "chat");
      expect(await s.storage.runs.load(s.identity, childId)).toBeUndefined();
      expect(await s.storage.runs.load(s.identity, runId)).toBeUndefined();
      expect(
        await s.storage.actions.load(s.identity, actionId),
      ).toBeUndefined();
    });
  });
