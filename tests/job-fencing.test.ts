import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { writeTool } from "../src/core/action.js";
import { operationId } from "../src/storage/actions.js";
import { RunLeaseError } from "../src/storage/runs.js";
import { openDatabase } from "../src/storage/database.js";
import { recordStore } from "../src/storage/records.js";

function gate() {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, waiting };
}
for (const driver of drivers)
  describe(`${driver} job publication fencing`, () => {
    it("rejects a paused worker's suspension after another owner reclaims and approves", async () => {
      const s = await storageFixture(driver);
      const ready = gate();
      const resume = gate();
      const call = { id: "call", name: "change", args: {} };
      const tool = writeTool({
        name: "change",
        description: "Change",
        version: "1",
        input: z.strictObject({}),
        authorize: () => Promise.resolve(true),
        prepare: () => Promise.resolve({ preview: "Change", version: "1" }),
        execute: () => Promise.resolve("receipt"),
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
          jobs: {
            ...s.storage.jobs,
            update: async (...args) => {
              if (args[3].type === "awaiting_approval") {
                ready.release();
                await resume.waiting;
              }
              return s.storage.jobs.update(...args);
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
        const oldTick = first.tick();
        await ready.waiting;
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
        restoreClock = () => {
          clock.mockRestore();
        };
        await replacement.tick();
        const approval = operationId(
          s.identity,
          JSON.stringify(["chat", "one"]),
          call.id,
        );
        await s.storage.actions.decide(s.identity, approval, true);
        await s.storage.jobs.update(s.identity, "chat", "one", {
          type: "queued",
        });
        const approved = await s.storage.jobs.load(s.identity, "chat", "one");
        resume.release();
        await oldTick;
        expect(await s.storage.jobs.load(s.identity, "chat", "one")).toEqual(
          approved,
        );
        expect(approved?.status).toBe("queued");
        expect(
          (await s.storage.actions.load(s.identity, approval))?.status,
        ).toBe("approved");
      } finally {
        resume.release();
        restoreClock();
        await first.stop();
        await replacement.stop();
      }
    });

    it("rolls back the run fence if job publication fails and rejects foreign or missing leases", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "Hello",
      });
      const runId = JSON.stringify(["chat", "one"]);
      const state = await s.storage.runs.claim(
        s.identity,
        runId,
        {
          input: "Hello",
          system: "Help",
          profileId: "v1",
          provider: "fake",
          tools: [],
          maxRounds: 8,
          maxToolCalls: 16,
        },
        30000,
      );
      if (!state.lease) throw new Error("Missing lease");
      const lease = { runId, token: state.lease.token };
      const db = await openDatabase(s.config);
      try {
        const records = recordStore(db, s.config.encryptionKey);
        const key = JSON.stringify([
          "run",
          s.identity.tenantId,
          s.identity.actorId,
          runId,
        ]);
        const before = await records.read(key);
        await expect(
          s.storage.jobs.update(
            s.identity,
            "chat",
            "one",
            { type: "progress" },
            undefined,
            { ...lease, token: "stale" },
          ),
        ).rejects.toBeInstanceOf(RunLeaseError);
        await expect(
          s.storage.jobs.update(
            s.identity,
            "chat",
            "other",
            { type: "progress" },
            undefined,
            lease,
          ),
        ).rejects.toBeInstanceOf(RunLeaseError);
        await expect(
          s.storage.jobs.update(
            s.identity,
            "chat",
            "absent",
            { type: "progress" },
            undefined,
            { runId: JSON.stringify(["chat", "absent"]), token: "missing" },
          ),
        ).rejects.toBeInstanceOf(RunLeaseError);
        const missing = JSON.stringify(["chat", "missing"]);
        const other = await s.storage.runs.claim(
          s.identity,
          missing,
          state.request,
          30000,
        );
        if (!other.lease) throw new Error("Missing lease");
        const otherKey = JSON.stringify([
          "run",
          s.identity.tenantId,
          s.identity.actorId,
          missing,
        ]);
        const old = await records.read(otherKey);
        await expect(
          s.storage.jobs.update(
            s.identity,
            "chat",
            "missing",
            { type: "progress" },
            undefined,
            { runId: missing, token: other.lease.token },
          ),
        ).rejects.toThrow("Run not found");
        expect(await records.read(otherKey)).toEqual(old);
        expect(await records.read(key)).toEqual(before);
        await s.storage.jobs.update(
          s.identity,
          "chat",
          "one",
          { type: "progress" },
          undefined,
          lease,
        );
        expect(
          (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
        ).toBe("progress");
      } finally {
        await db.destroy();
      }
    });
  });
