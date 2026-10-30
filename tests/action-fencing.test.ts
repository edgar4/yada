import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { writeTool } from "../src/core/action.js";
import { operationId } from "../src/storage/actions.js";
import { RunLeaseError } from "../src/storage/runs.js";
import { runDurable } from "../src/storage/durable-run.js";
import { actionExecutor } from "../src/service/actions.js";
import { CheckpointError } from "../src/core/checkpoint.js";

function gate() {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, waiting };
}
for (const driver of drivers)
  describe(`${driver} action dispatch fencing`, () => {
    it("automatically binds standalone durable executors to their claimed lease", async () => {
      const s = await storageFixture(driver);
      const ready = gate();
      const resume = gate();
      const call = { id: "call", name: "change", args: {} };
      const execute = vi.fn(() => Promise.resolve("receipt"));
      const tool = writeTool({
        name: "change",
        description: "Change",
        version: "1",
        input: z.strictObject({}),
        authorize: () => Promise.resolve(true),
        prepare: () => Promise.resolve({ preview: "Change", version: "1" }),
        execute,
        reconcile: () => Promise.resolve(undefined),
      });
      const options = {
        runId: "run",
        profileId: "v1",
        identity: s.identity,
        store: s.storage.runs,
        provider: createFakeProvider(() => ({
          content: "",
          toolCalls: [call],
          finishReason: "tool_calls",
        })),
        tools: [tool],
        input: "Change",
        system: "Help",
        leaseMs: 1000,
        signal: AbortSignal.timeout(10000),
        executeWrite: actionExecutor(
          {
            ...s.storage.actions,
            begin: async (...args) => {
              ready.release();
              await resume.waiting;
              return s.storage.actions.begin(...args);
            },
          },
          s.identity,
          "run",
        ),
      };
      expect(await runDurable(options)).toMatchObject({
        status: "awaiting_approval",
      });
      await s.storage.actions.decide(
        s.identity,
        operationId(s.identity, "run", call.id),
        true,
      );
      const original = runDurable(options);
      await ready.waiting;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
      try {
        expect(
          await runDurable({
            ...options,
            signal: AbortSignal.abort(),
            executeWrite: actionExecutor(s.storage.actions, s.identity, "run"),
          }),
        ).toEqual({ status: "cancelled" });
        const saved = await s.storage.runs.load(s.identity, "run");
        resume.release();
        await expect(original).rejects.toBeInstanceOf(CheckpointError);
        expect(execute).not.toHaveBeenCalled();
        expect(await s.storage.runs.load(s.identity, "run")).toEqual(saved);
      } finally {
        resume.release();
        clock.mockRestore();
        await original.catch(() => undefined);
      }
    });
    it("cannot dispatch a paused approved action after another worker cancels the run", async () => {
      const s = await storageFixture(driver);
      const ready = gate();
      const resume = gate();
      const call = { id: "call", name: "change", args: {} };
      const execute = vi.fn(() => Promise.resolve("receipt"));
      const tool = writeTool({
        name: "change",
        description: "Change",
        version: "1",
        input: z.strictObject({}),
        authorize: () => Promise.resolve(true),
        prepare: () => Promise.resolve({ preview: "Change", version: "1" }),
        execute,
        reconcile: () => Promise.resolve(undefined),
      });
      const profiles = {
        v1: {
          provider: createFakeProvider(() => ({
            content: "",
            toolCalls: [call],
            finishReason: "tool_calls",
          })),
          tools: [tool],
          system: "Help",
        },
      };
      const first = createWorker({
        storage: {
          ...s.storage,
          actions: {
            ...s.storage.actions,
            begin: async (...args) => {
              ready.release();
              await resume.waiting;
              return s.storage.actions.begin(...args);
            },
          },
        },
        profiles,
        leaseMs: 1000,
      });
      const replacement = createWorker({
        storage: s.storage,
        profiles,
        leaseMs: 1000,
      });
      let restoreClock = () => {};
      try {
        await s.storage.jobs.submit(s.identity, "chat", {
          id: "one",
          profileId: "v1",
          input: "Change",
        });
        await first.tick();
        const id = operationId(
          s.identity,
          JSON.stringify(["chat", "one"]),
          call.id,
        );
        await s.storage.actions.decide(s.identity, id, true);
        await s.storage.jobs.update(s.identity, "chat", "one", {
          type: "queued",
        });
        await first.tick();
        const oldTick = first.tick();
        await ready.waiting;
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
        restoreClock = () => {
          clock.mockRestore();
        };
        await s.storage.jobs.cancel(s.identity, "chat", "one");
        await replacement.tick();
        const cancelled = await s.storage.jobs.load(s.identity, "chat", "one");
        expect(cancelled?.status).toBe("cancelled");
        const checkpoint = await s.storage.runs.load(
          s.identity,
          JSON.stringify(["chat", "one"]),
        );
        resume.release();
        await oldTick;
        expect(execute).not.toHaveBeenCalled();
        expect(await s.storage.jobs.load(s.identity, "chat", "one")).toEqual(
          cancelled,
        );
        expect(
          await s.storage.runs.load(
            s.identity,
            JSON.stringify(["chat", "one"]),
          ),
        ).toEqual(checkpoint);
        expect((await s.storage.actions.load(s.identity, id))?.status).toBe(
          "approved",
        );
      } finally {
        resume.release();
        restoreClock();
        await first.stop();
        await replacement.stop();
      }
    });

    it("binds action ownership to its run and checks approval expiry within the transaction", async () => {
      const s = await storageFixture(driver);
      const request = {
        input: "Change",
        system: "Help",
        profileId: "v1",
        provider: "fake",
        tools: [],
        maxRounds: 8,
        maxToolCalls: 16,
      };
      const state = await s.storage.runs.claim(
        s.identity,
        "run",
        request,
        30000,
      );
      const other = await s.storage.runs.claim(
        s.identity,
        "other",
        request,
        30000,
      );
      if (!state.lease || !other.lease) throw new Error("Missing lease");
      const id = operationId(s.identity, "run", "call");
      await s.storage.actions.propose(s.identity, {
        id,
        runId: "run",
        callId: "call",
        tool: "change",
        toolVersion: "1",
        args: {},
        preview: "Change",
        version: "1",
        expiresAt: Date.now() + 10000,
        status: "pending",
      });
      await s.storage.actions.decide(s.identity, id, true);
      await expect(
        s.storage.actions.begin(s.identity, id, {
          runId: "other",
          token: other.lease.token,
        }),
      ).rejects.toBeInstanceOf(RunLeaseError);
      expect((await s.storage.actions.load(s.identity, id))?.status).toBe(
        "approved",
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11000);
      try {
        expect(
          await s.storage.actions.begin(s.identity, id, {
            runId: "run",
            token: state.lease.token,
          }),
        ).toBe(false);
        expect((await s.storage.actions.load(s.identity, id))?.status).toBe(
          "expired",
        );
      } finally {
        clock.mockRestore();
      }
    });
  });
