import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createWorker } from "../src/service/worker.js";
import { z } from "zod";
import { writeTool } from "../src/core/action.js";
import { operationId } from "../src/storage/actions.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { RunLeaseError } from "../src/storage/runs.js";
import { openDatabase } from "../src/storage/database.js";
import { recordStore } from "../src/storage/records.js";
import { createJobStore } from "../src/storage/jobs.js";

const done = () =>
  createFakeProvider(() => ({
    content: "Done",
    toolCalls: [],
    finishReason: "stop",
  }));
const hang = () => createFakeProvider(() => new Promise<never>(() => {}));
const input = (id: string) => ({ id, profileId: "v1", input: "Hello" });
const failing = (
  storage: Awaited<ReturnType<typeof storageFixture>>["storage"],
  error: Error,
) => ({
  ...storage,
  runs: { ...storage.runs, claim: () => Promise.reject(error) },
});
const queueKey = JSON.stringify(["job_queue"]);
async function queued(config: Parameters<typeof openDatabase>[0]) {
  const db = await openDatabase(config);
  try {
    const row = await recordStore(db, config.encryptionKey).read(queueKey);
    return row?.value as { complete: boolean; keys: string[] } | undefined;
  } finally {
    await db.destroy();
  }
}

for (const driver of drivers)
  describe(`${driver} job queue`, () => {
    it("backs off retryable failures and exhausts attempts", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      const trace = vi.fn();
      const profiles = { v1: { provider: done(), tools: [], system: "Help" } };
      const worker = createWorker({
        storage: failing(s.storage, new Error("db down")),
        profiles,
        maxAttempts: 3,
        trace,
      });
      const clock = vi.spyOn(Date, "now");
      const start = Date.now();
      clock.mockReturnValue(start);
      vi.spyOn(Math, "random").mockReturnValue(1);
      try {
        await worker.tick();
        const first = await s.storage.jobs.load(s.identity, "chat", "one");
        expect(first?.attempts).toBe(1);
        expect(first?.availableAt).toBe(start + 2000);
        await worker.tick();
        expect(
          (await s.storage.jobs.load(s.identity, "chat", "one"))?.attempts,
        ).toBe(1);
        clock.mockReturnValue(start + 2000);
        await worker.tick();
        const second = await s.storage.jobs.load(s.identity, "chat", "one");
        expect(second?.attempts).toBe(2);
        expect(second?.availableAt).toBe(start + 2000 + 4000);
        await worker.tick();
        clock.mockReturnValue(start + 6000);
        await worker.tick();
        const last = await s.storage.jobs.load(s.identity, "chat", "one");
        expect(last?.status).toBe("failed");
        expect(last?.outcome).toEqual({
          status: "failed",
          code: "retry_exhausted",
        });
        expect(trace).toHaveBeenLastCalledWith(
          expect.objectContaining({
            attempt: 3,
            code: "retry_exhausted",
            status: "failed",
          }),
        );
      } finally {
        vi.restoreAllMocks();
        await worker.stop();
      }
    });

    it("does not count lease conflicts as attempts", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      const worker = createWorker({
        storage: failing(s.storage, new RunLeaseError()),
        profiles: { v1: { provider: done(), tools: [], system: "Help" } },
      });
      await worker.tick();
      await worker.tick();
      await worker.stop();
      const job = await s.storage.jobs.load(s.identity, "chat", "one");
      expect(job?.attempts).toBe(0);
      expect(job?.status).toBe("queued");
    });

    it("fails timeouts, cancels on request and leaves shutdown resumable", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "timeout", input("one"));
      const timed = createWorker({
        storage: s.storage,
        profiles: {
          v1: { provider: hang(), tools: [], system: "Help", timeoutMs: 50 },
        },
      });
      await timed.tick();
      await timed.stop();
      const job = await s.storage.jobs.load(s.identity, "timeout", "one");
      expect(job?.status).toBe("failed");
      expect(job?.outcome).toEqual({ status: "failed", code: "timeout" });

      await s.storage.jobs.submit(s.identity, "cancel", input("two"));
      const provider = hang();
      const cancelled = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [], system: "Help" } },
        leaseMs: 100,
        pollMs: 10,
      });
      cancelled.start();
      await vi.waitFor(() => {
        expect(provider.requests).toHaveLength(1);
      });
      await s.storage.jobs.cancel(s.identity, "cancel", "two");
      await vi.waitFor(async () => {
        expect(
          (await s.storage.jobs.load(s.identity, "cancel", "two"))?.status,
        ).toBe("cancelled");
      });
      await cancelled.stop();

      await s.storage.jobs.submit(s.identity, "stop", input("three"));
      const pending = hang();
      const stopped = createWorker({
        storage: s.storage,
        profiles: { v1: { provider: pending, tools: [], system: "Help" } },
        leaseMs: 5000,
        pollMs: 10,
      });
      stopped.start();
      await vi.waitFor(() => {
        expect(pending.requests).toHaveLength(1);
      });
      await stopped.stop();
      const resumable = await s.storage.jobs.load(s.identity, "stop", "three");
      expect(resumable?.status).not.toBe("failed");
      expect(resumable?.outcome).toBeUndefined();
      expect(resumable?.attempts).toBe(0);
    });

    it("never finalizes a job whose write action is executing", async () => {
      const s = await storageFixture(driver);
      const call = { id: "call", name: "change", args: {} };
      const tool = writeTool({
        name: "change",
        description: "Change",
        version: "1",
        input: z.strictObject({}),
        authorize: () => Promise.resolve(true),
        prepare: () => Promise.resolve({ preview: "Change", version: "1" }),
        execute: () => new Promise<never>(() => {}),
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
          timeoutMs: 200,
        },
      };
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      const suspend = createWorker({ storage: s.storage, profiles });
      await suspend.tick();
      await s.storage.actions.decide(
        s.identity,
        operationId(s.identity, JSON.stringify(["chat", "one"]), call.id),
        true,
      );
      await s.storage.jobs.update(s.identity, "chat", "one", {
        type: "queued",
      });
      const clock = vi.spyOn(Date, "now");
      try {
        await suspend.tick();
        await suspend.tick();
        const timedOut = await s.storage.jobs.load(s.identity, "chat", "one");
        expect(timedOut?.status).toBe("reconciling");
        expect(timedOut?.outcome).toBeUndefined();
        await s.storage.jobs.update(s.identity, "chat", "one", {
          type: "queued",
        });
        clock.mockReturnValue(Date.now() + 120_000);
        const broken = createWorker({
          storage: failing(s.storage, new Error("db down")),
          profiles,
          maxAttempts: 1,
        });
        await broken.tick();
        await broken.tick();
        await broken.stop();
        const held = await s.storage.jobs.load(s.identity, "chat", "one");
        expect(held?.outcome).toBeUndefined();
        expect(held?.status).toBe("queued");
        expect(held?.attempts).toBeGreaterThan(0);
      } finally {
        vi.restoreAllMocks();
        await suspend.stop();
      }
    });

    it("runs jobs concurrently up to the limit", async () => {
      const s = await storageFixture(driver);
      for (let index = 0; index < 5; index++)
        await s.storage.jobs.submit(
          s.identity,
          `chat-${String(index)}`,
          input("one"),
        );
      let running = 0;
      let peak = 0;
      const provider = createFakeProvider(async () => {
        peak = Math.max(peak, ++running);
        await delay(40);
        running--;
        return { content: "Done", toolCalls: [], finishReason: "stop" };
      });
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [], system: "Help" } },
        concurrency: 3,
      });
      await worker.tick();
      await worker.stop();
      expect(peak).toBe(3);
      for (let index = 0; index < 5; index++)
        expect(
          (
            await s.storage.jobs.load(
              s.identity,
              `chat-${String(index)}`,
              "one",
            )
          )?.status,
        ).toBe("completed");
    });

    it("tracks only conversations with active jobs", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "a", input("one"));
      await s.storage.jobs.submit(s.identity, "b", input("two"));
      await Promise.all(
        ["c", "d", "e"].map((id) =>
          s.storage.jobs.submit(s.identity, id, input("x")),
        ),
      );
      expect((await queued(s.config))?.keys).toHaveLength(5);
      expect(
        (await s.storage.jobs.pending()).jobs
          .map((item) => item.conversationId)
          .sort(),
      ).toEqual(["a", "b", "c", "d", "e"]);
      await s.storage.jobs.cancel(s.identity, "a", "one");
      await s.storage.jobs.update(
        s.identity,
        "a",
        "one",
        { type: "cancelled" },
        { status: "cancelled" },
      );
      await s.storage.jobs.update(
        s.identity,
        "b",
        "two",
        { type: "completed", text: "ok" },
        { status: "completed", text: "ok" },
      );
      expect((await queued(s.config))?.keys).toHaveLength(3);
      expect(
        (await s.storage.jobs.pending()).jobs.map(
          (item) => item.conversationId,
        ),
      ).not.toContain("a");
      await s.storage.jobs.prune(s.identity, "a", Date.now() + 1);
      expect((await queued(s.config))?.keys).toHaveLength(3);
      await s.storage.jobs.submit(s.identity, "a", input("again"));
      expect((await queued(s.config))?.keys).toHaveLength(4);
    });

    it("rebuilds a missing index from existing conversations", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "a", input("one"));
      await s.storage.jobs.submit(s.identity, "b", input("two"));
      await s.storage.jobs.update(
        s.identity,
        "b",
        "two",
        { type: "completed", text: "ok" },
        { status: "completed", text: "ok" },
      );
      const db = await openDatabase(s.config);
      try {
        await db("yada_records").where({ kind: "job_queue" }).delete();
      } finally {
        await db.destroy();
      }
      expect(await queued(s.config)).toBeUndefined();
      const page = await s.storage.jobs.pending();
      expect(page.jobs.map((item) => item.conversationId)).toEqual(["a"]);
      expect(await queued(s.config)).toMatchObject({ complete: true });
      expect((await queued(s.config))?.keys).toHaveLength(1);
    });
    it("writes the job and its queue entry atomically", async () => {
      const s = await storageFixture(driver);
      const db = await openDatabase(s.config);
      try {
        const records = recordStore(db, s.config.encryptionKey);
        const broken = createJobStore({
          ...records,
          transaction: (operation) =>
            records.transaction((tx) =>
              operation({
                ...tx,
                write: (key, value, revision) =>
                  key === queueKey
                    ? Promise.reject(new Error("crash"))
                    : tx.write(key, value, revision),
              }),
            ),
        });
        await expect(
          broken.submit(s.identity, "chat", input("one")),
        ).rejects.toThrow("crash");
        expect(await s.storage.jobs.load(s.identity, "chat", "one")).toBe(
          undefined,
        );
        await s.storage.jobs.pending();
        await s.storage.jobs.submit(s.identity, "chat", input("one"));
        expect(
          (await s.storage.jobs.pending()).jobs.map((item) => item.job.id),
        ).toEqual(["one"]);
      } finally {
        await db.destroy();
      }
    });

    it("leaves a job alone when another worker holds a live lease", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      const runId = JSON.stringify(["chat", "one"]);
      await s.storage.runs.claim(
        s.identity,
        runId,
        {
          input: "Hello",
          history: [],
          system: "Help",
          profileId: "v1",
          provider: "fake",
          tools: [],
          maxRounds: 8,
          maxToolCalls: 16,
        },
        60_000,
      );
      const worker = createWorker({
        storage: failing(s.storage, new Error("db down")),
        profiles: { v1: { provider: done(), tools: [], system: "Help" } },
        maxAttempts: 1,
      });
      await worker.tick();
      await worker.stop();
      const job = await s.storage.jobs.load(s.identity, "chat", "one");
      expect(job?.status).toBe("queued");
      expect(job?.attempts).toBe(0);
    });

    it("wakes an approval wait after the configured ttl", async () => {
      const s = await storageFixture(driver);
      const tool = writeTool({
        name: "change",
        description: "Change",
        version: "1",
        input: z.strictObject({}),
        authorize: () => Promise.resolve(true),
        prepare: () => Promise.resolve({ preview: "Change", version: "1" }),
        execute: () => Promise.resolve("ok"),
      });
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      const worker = createWorker({
        storage: s.storage,
        profiles: {
          v1: {
            provider: createFakeProvider(() => ({
              content: "",
              toolCalls: [{ id: "call", name: "change", args: {} }],
              finishReason: "tool_calls",
            })),
            tools: [tool],
            system: "Help",
            approvalTtlMs: 60_000,
          },
        },
      });
      await worker.tick();
      await worker.stop();
      const job = await s.storage.jobs.load(s.identity, "chat", "one");
      expect(job?.status).toBe("awaiting_approval");
      expect(job?.availableAt).toBeGreaterThan(Date.now() + 50_000);
      expect(job?.availableAt).toBeLessThanOrEqual(Date.now() + 60_000);
    });
  });
