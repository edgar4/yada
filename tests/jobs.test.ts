import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { JobConflict } from "../src/storage/jobs.js";
for (const driver of drivers)
  describe(`${driver} durable service`, () => {
    it("discovers queued runs after restart and projects history once", async () => {
      const s = await storageFixture(driver);
      const input = { id: "one", profileId: "v1", input: "Hello" };
      await s.storage.jobs.submit(s.identity, "chat", input);
      expect(
        (await s.storage.jobs.submit(s.identity, "chat", input)).events,
      ).toHaveLength(1);
      await s.reopen();
      const provider = createFakeProvider(() => ({
        content: "Hi",
        toolCalls: [],
        finishReason: "stop",
      }));
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [], system: "Help" } },
      });
      await worker.tick();
      await worker.tick();
      const job = await s.storage.jobs.load(s.identity, "chat", "one");
      expect(job?.status).toBe("completed");
      expect(job?.events.map((event) => event.sequence)).toEqual(
        job?.events.map((_, index) => index + 1),
      );
      expect(
        (await s.storage.conversations.load(s.identity, "chat"))?.messages,
      ).toHaveLength(2);
      expect(provider.requests).toHaveLength(1);
      const next = await s.storage.jobs.submit(s.identity, "chat", {
        ...input,
        id: "two",
        input: "Again",
      });
      expect(next.history).toHaveLength(2);
      await worker.tick();
      expect(provider.requests.at(-1)?.messages).toHaveLength(3);
      await worker.stop();
    });
    it("serializes a conversation and isolates tenants", async () => {
      const s = await storageFixture(driver);
      const input = { id: "one", profileId: "v1", input: "Hi" };
      const results = await Promise.allSettled([
        s.storage.jobs.submit(s.identity, "chat", input),
        s.storage.jobs.submit(s.identity, "chat", { ...input, id: "two" }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toBeInstanceOf(JobConflict);
      expect(
        await s.storage.jobs.load(
          { ...s.identity, actorId: "other" },
          "chat",
          "one",
        ),
      ).toBeUndefined();
      await expect(
        s.storage.conversations.save(s.identity, "chat", [], 1),
      ).rejects.toThrow("service");
    });
    it("persists cancellation and redacts telemetry", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "secret",
      });
      await s.storage.jobs.cancel(s.identity, "chat", "one");
      const provider = createFakeProvider(() => ({
        content: "Secret",
        toolCalls: [],
        finishReason: "stop",
      }));
      const trace = vi.fn();
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [], system: "Help" } },
        trace,
      });
      await worker.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
      ).toBe("cancelled");
      expect(provider.requests).toHaveLength(0);
      expect(JSON.stringify(trace.mock.calls)).not.toContain("secret");
      expect(
        await s.storage.jobs.prune(s.identity, "chat", Date.now() + 1),
      ).toEqual(["one"]);
      await worker.stop();
    });
    it("stops workers without terminal cancellation and automatically resumes", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "Hello",
      });
      const provider = createFakeProvider(() => new Promise<never>(() => {}));
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [], system: "Help" } },
        leaseMs: 100,
        pollMs: 10,
      });
      worker.start();
      await vi.waitFor(() => {
        expect(provider.requests).toHaveLength(1);
      });
      await worker.stop();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.outcome,
      ).toBeUndefined();
      await delay(120);
      const resumed = createWorker({
        storage: s.storage,
        profiles: {
          v1: {
            provider: createFakeProvider(() => ({
              content: "Recovered",
              toolCalls: [],
              finishReason: "stop",
            })),
            tools: [],
            system: "Help",
          },
        },
      });
      await resumed.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.outcome,
      ).toEqual({ status: "completed", text: "Recovered" });
      await resumed.stop();
    });
  });
it("retries storage outages and refuses a second scheduler", async () => {
  const s = await storageFixture("sqlite");
  const trace = vi.fn();
  const worker = createWorker({
    storage: {
      ...s.storage,
      jobs: {
        ...s.storage.jobs,
        pending: () => Promise.reject(new Error("secret connection")),
      },
    },
    profiles: {},
    pollMs: 10,
    trace,
  });
  worker.start();
  expect(() => {
    worker.start();
  }).toThrow("already started");
  await vi.waitFor(() => {
    expect(trace).toHaveBeenCalled();
  });
  await worker.stop();
  expect(JSON.stringify(trace.mock.calls)).not.toContain("secret");
});
