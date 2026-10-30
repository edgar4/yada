import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { drivers, storageFixture } from "./helpers/storage.js";
import { writeTool } from "../src/core/action.js";
import { actionExecutor } from "../src/service/actions.js";
import { operationId } from "../src/storage/actions.js";
import { runDurable } from "../src/storage/durable-run.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { createWorker } from "../src/service/worker.js";
function toolFixture() {
  const execute = vi.fn(() => Promise.resolve("Receipt: done"));
  const prepare = vi.fn(() =>
    Promise.resolve({ preview: "Change name to Ada", version: "revision-1" }),
  );
  const reconcile = vi.fn(() => Promise.resolve<string | undefined>(undefined));
  const authorize = vi.fn(() => Promise.resolve(true));
  const tool = writeTool({
    name: "rename",
    description: "Rename",
    version: "1",
    input: z.strictObject({ name: z.string() }),
    authorize,
    prepare,
    execute,
    reconcile,
  });
  return { execute, prepare, reconcile, authorize, tool };
}
const call = { id: "call", name: "rename", args: { name: "Ada" } };
for (const driver of drivers)
  describe(`${driver} durable actions`, () => {
    it("binds exact arguments and executes only once after explicit approval", async () => {
      const s = await storageFixture(driver);
      const t = toolFixture();
      const invoke = actionExecutor(s.storage.actions, s.identity, "run");
      const id = operationId(s.identity, "run", call.id);
      expect(await invoke(t.tool, call, AbortSignal.timeout(3000))).toEqual({
        status: "awaiting_approval",
        approvalId: id,
      });
      expect(t.execute).not.toHaveBeenCalled();
      await expect(
        invoke(
          t.tool,
          { ...call, args: { name: "Mallory" } },
          AbortSignal.timeout(3000),
        ),
      ).rejects.toThrow("mismatch");
      await expect(
        s.storage.actions.decide({ ...s.identity, actorId: "other" }, id, true),
      ).rejects.toThrow();
      await s.storage.actions.decide(s.identity, id, true);
      await s.storage.actions.decide(s.identity, id, true);
      await Promise.all([
        invoke(t.tool, call, AbortSignal.timeout(3000)),
        invoke(t.tool, call, AbortSignal.timeout(3000)),
      ]);
      expect(t.execute).toHaveBeenCalledOnce();
      expect(await invoke(t.tool, call, AbortSignal.timeout(3000))).toBe(
        "Receipt: done",
      );
      expect((await s.storage.actions.load(s.identity, id))?.status).toBe(
        "completed",
      );
      await expect(
        s.storage.actions.receipt(s.identity, id, "different"),
      ).rejects.toThrow("conflict");
    });
    it("reconciles a lost response without repeating the write", async () => {
      const s = await storageFixture(driver);
      const t = toolFixture();
      const invoke = actionExecutor(s.storage.actions, s.identity, "run");
      const id = operationId(s.identity, "run", call.id);
      await invoke(t.tool, call, AbortSignal.timeout(3000));
      await s.storage.actions.decide(s.identity, id, true);
      t.execute.mockRejectedValue(new Error("Connection lost"));
      expect(
        await invoke(t.tool, call, AbortSignal.timeout(3000)),
      ).toMatchObject({ status: "reconciling" });
      await s.reopen();
      const recovered = actionExecutor(s.storage.actions, s.identity, "run");
      expect(
        await recovered(t.tool, call, AbortSignal.timeout(3000)),
      ).toMatchObject({ status: "reconciling" });
      t.reconcile.mockResolvedValue("Receipt: done");
      expect(await recovered(t.tool, call, AbortSignal.timeout(3000))).toBe(
        "Receipt: done",
      );
      expect(t.execute).toHaveBeenCalledOnce();
    });
    it("rejects expired approvals, stale state, revoked access and invalid arguments", async () => {
      const s = await storageFixture(driver);
      const t = toolFixture();
      const expired = actionExecutor(
        s.storage.actions,
        s.identity,
        "expired",
        -1,
      );
      expect(await expired(t.tool, call, AbortSignal.timeout(3000))).toContain(
        "expired",
      );
      const invoke = actionExecutor(s.storage.actions, s.identity, "run");
      await invoke(t.tool, call, AbortSignal.timeout(3000));
      const id = operationId(s.identity, "run", call.id);
      await s.storage.actions.decide(s.identity, id, true);
      t.prepare.mockResolvedValue({
        preview: "Changed",
        version: "revision-2",
      });
      await expect(
        invoke(t.tool, call, AbortSignal.timeout(3000)),
      ).rejects.toThrow("state changed");
      t.prepare.mockResolvedValue({
        preview: "Change name to Ada",
        version: "revision-1",
      });
      t.authorize.mockResolvedValue(false);
      await expect(
        invoke(t.tool, call, AbortSignal.timeout(3000)),
      ).rejects.toThrow("revoked");
      await expect(
        t.tool.prepare(
          { unexpected: true },
          s.identity,
          AbortSignal.timeout(3000),
        ),
      ).rejects.toThrow();
      expect(t.execute).not.toHaveBeenCalled();
    });
    it("suspends and resumes the runtime with the same call and durable receipt", async () => {
      const s = await storageFixture(driver);
      const t = toolFixture();
      const provider = createFakeProvider((_req, n) =>
        n === 1
          ? { content: "", toolCalls: [call], finishReason: "tool_calls" }
          : { content: "Done", toolCalls: [], finishReason: "stop" },
      );
      const options = {
        store: s.storage.runs,
        identity: s.identity,
        runId: "run",
        profileId: "v1",
        provider,
        tools: [t.tool],
        input: "Rename",
        system: "Help",
        signal: AbortSignal.timeout(3000),
        executeWrite: actionExecutor(s.storage.actions, s.identity, "run"),
      };
      expect(await runDurable(options)).toMatchObject({
        status: "awaiting_approval",
      });
      await s.storage.actions.decide(
        s.identity,
        operationId(s.identity, "run", call.id),
        true,
      );
      expect(await runDurable(options)).toEqual({
        status: "completed",
        text: "Done",
      });
      expect(provider.requests).toHaveLength(2);
      expect(t.execute).toHaveBeenCalledOnce();
    });
    it("does not poll awaiting approvals and supports declining through the worker", async () => {
      const s = await storageFixture(driver);
      const t = toolFixture();
      const provider = createFakeProvider((_req, n) =>
        n === 1
          ? { content: "", toolCalls: [call], finishReason: "tool_calls" }
          : { content: "Declined", toolCalls: [], finishReason: "stop" },
      );
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "run",
        input: "Rename",
        profileId: "v1",
      });
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [t.tool], system: "Help" } },
      });
      await worker.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "run"))?.status,
      ).toBe("awaiting_approval");
      await worker.tick();
      const id = operationId(
        s.identity,
        JSON.stringify(["chat", "run"]),
        call.id,
      );
      await s.storage.actions.decide(s.identity, id, false);
      await s.storage.jobs.update(s.identity, "chat", "run", {
        type: "queued",
      });
      await worker.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "run"))?.status,
      ).toBe("completed");
      expect(t.execute).not.toHaveBeenCalled();
      await worker.stop();
    });
  });
it("expires an approved action before execution and rejects out-of-order receipts", async () => {
  const s = await storageFixture("sqlite");
  const t = toolFixture();
  const invoke = actionExecutor(s.storage.actions, s.identity, "run", 10_000);
  await invoke(t.tool, call, AbortSignal.timeout(3000));
  const id = operationId(s.identity, "run", call.id);
  await expect(
    s.storage.actions.receipt(s.identity, id, "premature"),
  ).rejects.toThrow("not executing");
  await s.storage.actions.decide(s.identity, id, true);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20000);
  try {
    expect(await invoke(t.tool, call, AbortSignal.timeout(3000))).toContain(
      "expired",
    );
  } finally {
    now.mockRestore();
  }
  expect(t.execute).not.toHaveBeenCalled();
});
it("reconciles an uncertain write even after cancellation was requested", async () => {
  const s = await storageFixture("sqlite");
  const t = toolFixture();
  const provider = createFakeProvider((_req, n) =>
    n === 1
      ? { content: "", toolCalls: [call], finishReason: "tool_calls" }
      : { content: "Receipt confirmed", toolCalls: [], finishReason: "stop" },
  );
  const profiles = { v1: { provider, tools: [t.tool], system: "Help" } };
  await s.storage.jobs.submit(s.identity, "chat", {
    id: "run",
    input: "Rename",
    profileId: "v1",
  });
  const worker = createWorker({ storage: s.storage, profiles });
  await worker.tick();
  const id = operationId(s.identity, JSON.stringify(["chat", "run"]), call.id);
  await s.storage.actions.decide(s.identity, id, true);
  await s.storage.jobs.update(s.identity, "chat", "run", { type: "queued" });
  t.execute.mockRejectedValue(new Error("Response lost"));
  await worker.tick();
  await worker.tick();
  expect((await s.storage.jobs.load(s.identity, "chat", "run"))?.status).toBe(
    "reconciling",
  );
  await worker.stop();
  await s.storage.jobs.cancel(s.identity, "chat", "run");
  t.reconcile
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue("Receipt: done");
  const resumed = createWorker({ storage: s.storage, profiles });
  await resumed.tick();
  expect((await s.storage.jobs.load(s.identity, "chat", "run"))?.status).toBe(
    "reconciling",
  );
  await resumed.tick();
  await resumed.tick();
  expect((await s.storage.jobs.load(s.identity, "chat", "run"))?.status).toBe(
    "completed",
  );
  expect(t.execute).toHaveBeenCalledOnce();
  await resumed.stop();
});
