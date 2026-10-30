import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { writeTool } from "../src/core/action.js";
import { operationId } from "../src/storage/actions.js";
import { createRetention } from "../src/storage/retention.js";
import { openDatabase } from "../src/storage/database.js";
import { recordStore, StorageConflict } from "../src/storage/records.js";
import { run } from "../src/core/runtime.js";
import { actionExecutor } from "../src/service/actions.js";
import { CheckpointError } from "../src/core/checkpoint.js";
import { conversationKey } from "../src/storage/conversations.js";

function gate() {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, waiting };
}
function toolFixture() {
  const authorize = vi.fn(() => Promise.resolve(true));
  const execute = vi.fn(() => Promise.resolve("receipt"));
  const reconcile = vi.fn(() => Promise.resolve<string | undefined>(undefined));
  const tool = writeTool({
    name: "change",
    description: "Change",
    version: "1",
    input: z.strictObject({}),
    authorize,
    prepare: () => Promise.resolve({ preview: "Change", version: "1" }),
    execute,
    reconcile,
  });
  return { tool, authorize, execute, reconcile };
}
const call = { id: "call", name: "change", args: {} };
for (const driver of drivers)
  describe(`${driver} lifecycle hardening`, () => {
    it("publishes suspension before releasing the run and cannot overwrite approval wakeups", async () => {
      const s = await storageFixture(driver);
      const t = toolFixture();
      const published = gate();
      const finishPublication = gate();
      const scanned = gate();
      const finishScan = gate();
      const profile = {
        provider: createFakeProvider(() => ({
          content: "",
          toolCalls: [call],
          finishReason: "tool_calls",
        })),
        tools: [t.tool],
        system: "Help",
      };
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "Change",
      });
      const first = createWorker({
        storage: {
          ...s.storage,
          jobs: {
            ...s.storage.jobs,
            update: async (...args) => {
              if (args[3].type === "awaiting_approval") {
                published.release();
                await finishPublication.waiting;
              }
              return s.storage.jobs.update(...args);
            },
          },
        },
        profiles: { v1: profile },
      });
      const second = createWorker({
        storage: {
          ...s.storage,
          jobs: {
            ...s.storage.jobs,
            pending: async (...args) => {
              const page = await s.storage.jobs.pending(...args);
              scanned.release();
              await finishScan.waiting;
              return page;
            },
          },
        },
        profiles: { v1: profile },
      });
      try {
        const firstTick = first.tick();
        await published.waiting;
        const runId = JSON.stringify(["chat", "one"]);
        const saved = await s.storage.runs.load(s.identity, runId);
        expect(saved?.lease?.expiresAt).toBeGreaterThan(Date.now());
        const secondTick = second.tick();
        await scanned.waiting;
        const approval = operationId(s.identity, runId, call.id);
        finishPublication.release();
        await firstTick;
        const waiting = await s.storage.jobs.load(s.identity, "chat", "one");
        finishScan.release();
        await secondTick;
        expect(
          (await s.storage.jobs.load(s.identity, "chat", "one"))?.events,
        ).toEqual(waiting?.events);
        await s.storage.actions.decide(s.identity, approval, true);
        await s.storage.jobs.update(s.identity, "chat", "one", {
          type: "queued",
        });
        expect(
          (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
        ).toBe("queued");
        await second.tick();
        await second.tick();
        expect(t.execute).toHaveBeenCalledOnce();
      } finally {
        finishPublication.release();
        finishScan.release();
        await first.stop();
        await second.stop();
      }
    });
    it("retains uncertain writes through authorization loss and blocks erasure independently", async () => {
      const s = await storageFixture(driver);
      const t = toolFixture();
      t.execute.mockRejectedValue(new Error("Response lost"));
      const profile = {
        provider: createFakeProvider(() => ({
          content: "",
          toolCalls: [call],
          finishReason: "tool_calls",
        })),
        tools: [t.tool],
        system: "Help",
      };
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "Change",
      });
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: profile },
      });
      try {
        await worker.tick();
        const id = operationId(
          s.identity,
          JSON.stringify(["chat", "one"]),
          call.id,
        );
        await s.storage.actions.decide(s.identity, id, true);
        await s.storage.jobs.update(s.identity, "chat", "one", {
          type: "queued",
        });
        await worker.tick();
        await worker.tick();
        t.authorize.mockResolvedValue(false);
        await s.storage.jobs.cancel(s.identity, "chat", "one");
        await worker.tick();
        await worker.tick();
        const suspended = await s.storage.jobs.load(s.identity, "chat", "one");
        expect(suspended?.status).toBe("reconciling");
        expect(suspended?.outcome).toBeUndefined();
        const count = suspended?.events.length;
        await worker.tick();
        await worker.tick();
        expect(
          (await s.storage.jobs.load(s.identity, "chat", "one"))?.events,
        ).toHaveLength(count ?? 0);
        await expect(
          s.storage.retention.eraseConversation(s.identity, "chat"),
        ).rejects.toThrow();
        await s.storage.jobs.update(
          s.identity,
          "chat",
          "one",
          { type: "failed", code: "old-terminal-state" },
          { status: "failed", code: "tool_denied" },
        );
        await expect(
          s.storage.retention.eraseConversation(s.identity, "chat"),
        ).rejects.toThrow("unfinished actions");
        expect(
          await s.storage.jobs.load(s.identity, "chat", "one"),
        ).toBeDefined();
        expect((await s.storage.actions.load(s.identity, id))?.status).toBe(
          "executing",
        );
        await s.storage.actions.receipt(s.identity, id, "receipt");
        await s.storage.retention.eraseConversation(s.identity, "chat");
        expect(await s.storage.actions.load(s.identity, id)).toBeUndefined();
      } finally {
        await worker.stop();
      }
    });
    it("preserves concurrent updates and interrupted cleanup references through pruning", async () => {
      const s = await storageFixture(driver);
      const worker = createWorker({
        storage: s.storage,
        profiles: {
          v1: {
            provider: createFakeProvider(() => ({
              content: "Private",
              toolCalls: [],
              finishReason: "stop",
            })),
            tools: [],
            system: "Help",
          },
        },
      });
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "Private",
      });
      await worker.tick();
      await worker.stop();
      const db = await openDatabase(s.config);
      try {
        const records = recordStore(db, s.config.encryptionKey);
        let changed = false;
        const concurrent = createRetention({
          ...records,
          read: async (key) => {
            const record = await records.read(key);
            if (!changed && key.startsWith('["run",')) {
              changed = true;
              await s.storage.jobs.submit(s.identity, "chat", {
                id: "two",
                profileId: "v1",
                input: "Concurrent private input",
              });
              await s.storage.jobs.update(
                s.identity,
                "chat",
                "two",
                { type: "completed", text: "Concurrent private output" },
                { status: "completed", text: "Concurrent private output" },
              );
            }
            return record;
          },
        });
        await expect(
          concurrent.eraseConversation(s.identity, "chat"),
        ).rejects.toBeInstanceOf(StorageConflict);
        expect(
          (await s.storage.jobs.load(s.identity, "chat", "two"))?.outcome,
        ).toEqual({ status: "completed", text: "Concurrent private output" });
        const interrupted = createRetention({
          ...records,
          remove: () => Promise.reject(new Error("Storage offline")),
        });
        await expect(
          interrupted.eraseConversation(s.identity, "chat"),
        ).rejects.toThrow();
        await s.storage.jobs.prune(s.identity, "chat", Date.now() + 1);
        await s.storage.retention.eraseConversation(s.identity, "chat");
        expect(
          await s.storage.runs.load(
            s.identity,
            JSON.stringify(["chat", "one"]),
          ),
        ).toBeUndefined();
      } finally {
        await db.destroy();
      }
    });
    it("bounds retry noise while retaining approvals and terminal events", async () => {
      const s = await storageFixture(driver);
      const job = await s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "Hello",
      });
      const db = await openDatabase(s.config);
      try {
        const records = recordStore(db, s.config.encryptionKey);
        await records.mutate(conversationKey(s.identity, "chat"), (value) => ({
          value: {
            ...z.record(z.string(), z.unknown()).parse(value),
            jobs: [
              {
                ...job,
                events: Array.from({ length: 1000 }, (_, index) => ({
                  version: 1,
                  sequence: index + 1,
                  at: Date.now(),
                  type: index % 2 ? "running" : "progress",
                })),
              },
            ],
          },
          result: undefined,
        }));
      } finally {
        await db.destroy();
      }
      for (let index = 0; index < 5; index++)
        await s.storage.jobs.update(s.identity, "chat", "one", {
          type: index % 2 ? "running" : "progress",
        });
      await s.storage.jobs.update(s.identity, "chat", "one", {
        type: "reconciling",
        approvalId: "first",
      });
      await s.storage.jobs.update(s.identity, "chat", "one", {
        type: "awaiting_approval",
        approvalId: "second",
      });
      const completed = await s.storage.jobs.update(
        s.identity,
        "chat",
        "one",
        { type: "completed", text: "Done" },
        { status: "completed", text: "Done" },
      );
      expect(completed.events).toHaveLength(1003);
      expect(completed.events.slice(-3).map((event) => event.type)).toEqual([
        "reconciling",
        "awaiting_approval",
        "completed",
      ]);
      expect(completed.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 1003 }, (_, index) => index + 1),
      );
    });
  });
it("fails closed when unresolved-action inspection is unavailable, even during cancellation", async () => {
  const s = await storageFixture("sqlite");
  const t = toolFixture();
  const executeWrite = actionExecutor(
    {
      ...s.storage.actions,
      load: () => Promise.reject(new Error("Storage offline")),
    },
    s.identity,
    "run",
  );
  const checkpoint = {
    version: 1 as const,
    messages: [],
    pending: [call],
    rounds: 1,
    calls: 0,
  };
  const persist = vi.fn(() => Promise.resolve());
  await expect(
    run({
      provider: createFakeProvider(() => ({
        content: "",
        toolCalls: [],
        finishReason: "stop",
      })),
      tools: [t.tool],
      identity: s.identity,
      input: "Change",
      system: "Help",
      signal: AbortSignal.abort(),
      checkpoint,
      executeWrite,
      persist,
    }),
  ).rejects.toBeInstanceOf(CheckpointError);
  expect(persist).not.toHaveBeenCalled();
});
