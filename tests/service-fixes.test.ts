import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createHandler } from "../src/service/http.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { openDatabase } from "../src/storage/database.js";
import { recordStore, StorageConflict } from "../src/storage/records.js";
import { ActionConflict } from "../src/storage/actions.js";
import { RunLeaseError } from "../src/storage/runs.js";

const input = (id: string) => ({ id, profileId: "v1", input: "Hello" });
const done = { content: "Done", toolCalls: [], finishReason: "stop" } as const;
const until = async (check: () => Promise<boolean>) => {
  for (let index = 0; index < 200; index++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("Timed out");
};

for (const driver of drivers)
  describe(`${driver} service fixes`, () => {
    it("picks up new jobs while a long run is in flight", async () => {
      const s = await storageFixture(driver);
      let release = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const provider = createFakeProvider(async () => {
        if (calls++ === 0) await blocked;
        return done;
      });
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [], system: "Help" } },
        pollMs: 10,
        concurrency: 2,
      });
      worker.start();
      try {
        await s.storage.jobs.submit(s.identity, "a", input("one"));
        await until(() => Promise.resolve(calls === 1));
        await s.storage.jobs.submit(s.identity, "b", input("one"));
        await until(
          async () =>
            (await s.storage.jobs.load(s.identity, "b", "one"))?.status ===
            "completed",
        );
        expect(
          (await s.storage.jobs.load(s.identity, "a", "one"))?.status,
        ).not.toBe("completed");
        release();
        await until(
          async () =>
            (await s.storage.jobs.load(s.identity, "a", "one"))?.status ===
            "completed",
        );
      } finally {
        release();
        await worker.stop();
      }
    });

    it("finds jobs sorting before the previous page in one tick", async () => {
      const s = await storageFixture(driver);
      const worker = createWorker({
        storage: s.storage,
        profiles: {
          v1: {
            provider: createFakeProvider(() => done),
            tools: [],
            system: "Help",
          },
        },
      });
      await s.storage.jobs.submit(s.identity, "z", input("one"));
      await worker.tick();
      await s.storage.jobs.submit(s.identity, "a", input("one"));
      await worker.tick();
      await worker.stop();
      expect((await s.storage.jobs.load(s.identity, "a", "one"))?.status).toBe(
        "completed",
      );
    });

    it("does not fail a healthy run when cancellation checks error", async () => {
      const s = await storageFixture(driver);
      let failing = false;
      const worker = createWorker({
        storage: {
          ...s.storage,
          jobs: {
            ...s.storage.jobs,
            load: (...args) =>
              failing
                ? Promise.reject(new Error("transient"))
                : s.storage.jobs.load(...args),
          },
        },
        profiles: {
          v1: {
            provider: createFakeProvider(async () => {
              failing = true;
              await delay(400);
              failing = false;
              return done;
            }),
            tools: [],
            system: "Help",
          },
        },
        leaseMs: 300,
      });
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      await worker.tick();
      await worker.stop();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
      ).toBe("completed");
    });

    it("retries transactions on conflict and keeps lease loss fatal", async () => {
      const s = await storageFixture(driver);
      const db = await openDatabase(s.config);
      try {
        const records = recordStore(db, s.config.encryptionKey);
        let calls = 0;
        await expect(
          records.transact(() => {
            if (++calls < 3) throw new StorageConflict();
            return Promise.resolve("ok");
          }),
        ).resolves.toBe("ok");
        calls = 0;
        await expect(
          records.transact(() => {
            calls++;
            throw new StorageConflict();
          }),
        ).rejects.toBeInstanceOf(StorageConflict);
        expect(calls).toBe(20);
        calls = 0;
        await expect(
          records.transact(() => {
            calls++;
            throw new RunLeaseError();
          }),
        ).rejects.toBeInstanceOf(RunLeaseError);
        expect(calls).toBe(1);
      } finally {
        await db.destroy();
      }
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      await expect(
        s.storage.jobs.update(
          s.identity,
          "chat",
          "one",
          { type: "progress" },
          undefined,
          { runId: JSON.stringify(["chat", "one"]), token: "stale" },
        ),
      ).rejects.toBeInstanceOf(RunLeaseError);
    });

    it("resumes only the awaited approval", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      await s.storage.jobs.update(s.identity, "chat", "one", {
        type: "awaiting_approval",
        approvalId: "a1",
      });
      expect(await s.storage.jobs.resume(s.identity, "chat", "one", "a2")).toBe(
        false,
      );
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
      ).toBe("awaiting_approval");
      expect(await s.storage.jobs.resume(s.identity, "chat", "one", "a1")).toBe(
        true,
      );
      await s.storage.jobs.update(s.identity, "chat", "one", {
        type: "running",
      });
      expect(await s.storage.jobs.resume(s.identity, "chat", "one", "a1")).toBe(
        false,
      );
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
      ).toBe("running");
    });

    it("answers contradictory concurrent decisions with 409", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      await s.storage.jobs.update(s.identity, "chat", "one", {
        type: "awaiting_approval",
        approvalId: "a1",
      });
      await s.storage.actions.propose(s.identity, {
        id: "a1",
        runId: JSON.stringify(["chat", "one"]),
        callId: "c",
        tool: "t",
        toolVersion: "1",
        args: {},
        preview: "p",
        version: "1",
        expiresAt: Date.now() + 60_000,
        status: "pending",
      });
      await s.storage.actions.decide(s.identity, "a1", true);
      await expect(
        s.storage.actions.decide(s.identity, "a1", false),
      ).rejects.toBeInstanceOf(ActionConflict);
      const handler = createHandler({
        storage: s.storage,
        origins: [],
        authenticate: () => Promise.resolve(s.identity),
        authorizeProfile: () => Promise.resolve(true),
      });
      const response = await handler(
        new Request(
          "http://localhost/v1/conversations/chat/runs/one/approvals/a1/decision",
          { method: "POST", body: JSON.stringify({ approved: false }) },
        ),
      );
      expect(response.status).toBe(409);
    });
  });
