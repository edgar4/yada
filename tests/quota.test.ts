import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createHandler } from "../src/service/http.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { settleRun, type QuotaOptions } from "../src/service/quota.js";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});
async function setup(driver: (typeof drivers)[number], quota?: QuotaOptions) {
  const s = await storageFixture(driver);
  const other = { ...s.identity, actorId: "other-actor" };
  const handler = createHandler({
    storage: s.storage,
    origins: [],
    authenticate: (req) =>
      Promise.resolve(
        req.headers.get("authorization") === "other" ? other : s.identity,
      ),
    authorizeProfile: () => Promise.resolve(true),
    ...(quota ? { quota } : {}),
  });
  const submit = (id: string, conversation = id, as = "me") =>
    handler(
      new Request(`http://localhost/v1/conversations/${conversation}/runs`, {
        method: "POST",
        headers: { authorization: as, "content-type": "application/json" },
        body: JSON.stringify({ id, input: "Hi", profileId: "v1" }),
      }),
    );
  return { ...s, submit };
}
describe.each(drivers)("tenant quotas on %s", (driver) => {
  it("limits requests with Retry-After and rolls the window over", async () => {
    const s = await setup(driver, { requests: { limit: 2, windowMs: 60_000 } });
    expect((await s.submit("a")).status).toBe(202);
    vi.setSystemTime(1_010_000);
    expect((await s.submit("b")).status).toBe(202);
    const refused = await s.submit("c");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("50");
    expect(await refused.json()).toEqual({ error: "Rate limit exceeded" });
    vi.setSystemTime(1_060_000);
    expect((await s.submit("c")).status).toBe(202);
  });
  it("shares a tenant window across actors unless scoped to the actor", async () => {
    const requests = { limit: 1, windowMs: 60_000 };
    const tenant = await setup(driver, { requests });
    expect((await tenant.submit("a")).status).toBe(202);
    expect((await tenant.submit("b", "b", "other")).status).toBe(429);
    const actor = await setup(driver, { requests, scope: "actor" });
    expect((await actor.submit("a")).status).toBe(202);
    expect((await actor.submit("b", "b", "other")).status).toBe(202);
    expect((await actor.submit("c")).status).toBe(429);
  });
  it("does not consume quota for an idempotent resubmission", async () => {
    const s = await setup(driver, { requests: { limit: 1, windowMs: 60_000 } });
    expect((await s.submit("a", "chat")).status).toBe(202);
    expect((await s.submit("a", "chat")).status).toBe(202);
    expect((await s.submit("b", "other")).status).toBe(429);
  });
  it("does not exceed the limit under concurrent submissions", async () => {
    const s = await setup(driver, { requests: { limit: 3, windowMs: 60_000 } });
    const statuses = (
      await Promise.all(
        Array.from({ length: 8 }, (_, index) => s.submit(`r${String(index)}`)),
      )
    ).map((response) => response.status);
    expect(statuses.filter((status) => status === 202)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });
  it("accrues run cost and refuses submissions while over budget", async () => {
    const quota: QuotaOptions = {
      costMicros: { limit: 1000, windowMs: 60_000 },
    };
    const s = await setup(driver, quota);
    const worker = createWorker({
      storage: s.storage,
      quota,
      profiles: {
        v1: {
          provider: createFakeProvider(() => ({
            content: "Hello",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1000, outputTokens: 500 },
          })),
          tools: [],
          system: "Help",
          limits: {
            pricing: { inputMicrosPer1k: 400, outputMicrosPer1k: 400 },
          },
        },
      },
    });
    expect((await s.submit("a")).status).toBe(202);
    await worker.tick();
    expect((await s.submit("b")).status).toBe(202);
    await worker.tick();
    const refused = await s.submit("c");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    vi.setSystemTime(1_060_000);
    expect((await s.submit("c")).status).toBe(202);
    await worker.stop();
  });
  const worker = (
    s: Awaited<ReturnType<typeof setup>>,
    quota: QuotaOptions,
    usage: { inputTokens: number; outputTokens: number } | null = {
      inputTokens: 1000,
      outputTokens: 0,
    },
  ) =>
    createWorker({
      storage: s.storage,
      quota,
      concurrency: 16,
      profiles: {
        v1: {
          provider: createFakeProvider(() => ({
            content: "Hello",
            toolCalls: [],
            finishReason: "stop",
            ...(usage ? { usage } : {}),
          })),
          tools: [],
          system: "Help",
          limits: { pricing: { inputMicrosPer1k: 100, outputMicrosPer1k: 0 } },
        },
      },
    });
  const admitted = async (
    s: Awaited<ReturnType<typeof setup>>,
    prefix: string,
    count: number,
    as?: string,
  ) => {
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        s.submit(`${prefix}${String(index)}`, `${prefix}${String(index)}`, as),
      ),
    );
    return results.filter((result) => result.status === 202).length;
  };
  it("overshoots under concurrency without a reservation", async () => {
    const s = await setup(driver, {
      costMicros: { limit: 1000, windowMs: 60_000 },
    });
    expect(await admitted(s, "r", 8)).toBe(8);
  });
  it("holds concurrent runs to the budget with a reservation", async () => {
    const s = await setup(driver, {
      costMicros: { limit: 1000, windowMs: 60_000 },
      reserveCostMicros: 400,
    });
    expect(await admitted(s, "r", 8)).toBe(2);
    expect((await s.submit("late")).status).toBe(429);
  });
  it("settles to the actual cost and frees the rest", async () => {
    const quota: QuotaOptions = {
      costMicros: { limit: 1000, windowMs: 60_000 },
      reserveCostMicros: () => 400,
    };
    const s = await setup(driver, quota);
    const running = worker(s, quota);
    expect(await admitted(s, "a", 4)).toBe(2);
    await running.tick();
    await vi.waitFor(async () => {
      expect((await s.submit("next", "next")).status).toBe(202);
    });
    await running.stop();
  });
  it("releases the reservation when a run reports no usage", async () => {
    const quota: QuotaOptions = {
      costMicros: { limit: 400, windowMs: 60_000 },
      reserveCostMicros: 400,
    };
    const s = await setup(driver, quota);
    const running = worker(s, quota, null);
    expect((await s.submit("a")).status).toBe(202);
    expect((await s.submit("b")).status).toBe(429);
    await running.tick();
    await vi.waitFor(async () => {
      expect((await s.submit("b")).status).toBe(202);
    });
    await running.stop();
  });
  it("releases the reservation when retries are exhausted", async () => {
    const quota: QuotaOptions = {
      costMicros: { limit: 400, windowMs: 60_000 },
      reserveCostMicros: 400,
    };
    const s = await setup(driver, quota);
    const running = createWorker({
      storage: {
        ...s.storage,
        runs: {
          ...s.storage.runs,
          claim: () => Promise.reject(new Error("db down")),
        },
      },
      quota,
      maxAttempts: 1,
      profiles: {
        v1: {
          provider: createFakeProvider(() => ({
            content: "Hello",
            toolCalls: [],
            finishReason: "stop",
          })),
          tools: [],
          system: "Help",
        },
      },
    });
    expect((await s.submit("a")).status).toBe(202);
    expect((await s.submit("b")).status).toBe(429);
    await running.tick();
    await vi.waitFor(async () => {
      expect((await s.storage.jobs.load(s.identity, "a", "a"))?.status).toBe(
        "failed",
      );
    });
    await vi.waitFor(async () => {
      expect((await s.submit("b")).status).toBe(202);
    });
    await running.stop();
  });
  it("drops a reservation after its ttl", async () => {
    const s = await setup(driver, {
      costMicros: { limit: 400, windowMs: 3_600_000 },
      reserveCostMicros: 400,
      reservationTtlMs: 1000,
    });
    expect((await s.submit("a")).status).toBe(202);
    expect((await s.submit("b")).status).toBe(429);
    vi.setSystemTime(1_001_001);
    expect((await s.submit("b")).status).toBe(202);
  });
  it("releases the reservation when submission fails", async () => {
    const s = await setup(driver, {
      costMicros: { limit: 400, windowMs: 60_000 },
      reserveCostMicros: 400,
    });
    const spy = vi
      .spyOn(s.storage.jobs, "submit")
      .mockRejectedValueOnce(new Error("boom"));
    await s.submit("b", "other").catch(() => undefined);
    spy.mockRestore();
    expect((await s.submit("c", "third")).status).toBe(202);
  });
  it("keeps a hold when a duplicate submission of its run fails", async () => {
    const s = await setup(driver, {
      costMicros: { limit: 400, windowMs: 60_000 },
      reserveCostMicros: 400,
    });
    expect((await s.submit("a", "chat")).status).toBe(202);
    const inspect = vi
      .spyOn(s.storage.conversations, "inspect")
      .mockResolvedValueOnce({
        exists: false,
        active: false,
        submitted: false,
        erased: false,
      });
    const submit = vi
      .spyOn(s.storage.jobs, "submit")
      .mockRejectedValueOnce(new Error("conflict"));
    await s.submit("a", "chat").catch(() => undefined);
    inspect.mockRestore();
    submit.mockRestore();
    expect((await s.submit("b", "other")).status).toBe(429);
  });
  it("holds separately for actors reusing a run id", async () => {
    const s = await setup(driver, {
      costMicros: { limit: 800, windowMs: 60_000 },
      reserveCostMicros: 400,
    });
    expect((await s.submit("a", "chat")).status).toBe(202);
    expect((await s.submit("a", "chat", "other")).status).toBe(202);
    expect((await s.submit("b", "other")).status).toBe(429);
  });
  it("retries a failed settle and settles each record independently", async () => {
    const quota: QuotaOptions = {
      scope: "actor",
      globalCostMicros: { limit: 400, windowMs: 60_000 },
      costMicros: { limit: 400, windowMs: 60_000 },
      reserveCostMicros: 400,
    };
    const s = await setup(driver, quota);
    expect((await s.submit("a", "chat")).status).toBe(202);
    const real = s.storage.quota.settle.bind(s.storage.quota);
    let failures = 0;
    const settle = vi
      .spyOn(s.storage.quota, "settle")
      .mockImplementation((...args) =>
        failures++ === 0 ? Promise.reject(new Error("busy")) : real(...args),
      );
    const runKey = JSON.stringify(["chat", "a"]);
    await settleRun(s.storage.quota, s.identity, quota, runKey, 0);
    settle.mockRestore();
    expect(failures).toBe(3);
    expect((await s.submit("b", "b")).status).toBe(202);
  });
  it("is idempotent for a resubmitted run", async () => {
    const s = await setup(driver, {
      costMicros: { limit: 400, windowMs: 60_000 },
      reserveCostMicros: 400,
    });
    expect((await s.submit("a", "chat")).status).toBe(202);
    expect((await s.submit("a", "chat")).status).toBe(202);
  });
  it("enforces a global budget across actors", async () => {
    const s = await setup(driver, {
      scope: "actor",
      globalCostMicros: { limit: 400, windowMs: 60_000 },
      costMicros: { limit: 400, windowMs: 60_000 },
      reserveCostMicros: 400,
    });
    expect((await s.submit("a")).status).toBe(202);
    expect((await s.submit("b", "b", "other")).status).toBe(429);
  });
  it("returns the global hold when the scope denies", async () => {
    const s = await setup(driver, {
      scope: "actor",
      globalCostMicros: { limit: 800, windowMs: 60_000 },
      costMicros: { limit: 400, windowMs: 60_000 },
      reserveCostMicros: 400,
    });
    expect((await s.submit("a")).status).toBe(202);
    expect((await s.submit("b")).status).toBe(429);
    expect((await s.submit("c", "c", "other")).status).toBe(202);
  });
  it("accrues global cost without reservations", async () => {
    const quota: QuotaOptions = {
      globalCostMicros: { limit: 100, windowMs: 60_000 },
    };
    const s = await setup(driver, quota);
    const running = worker(s, quota);
    expect((await s.submit("a")).status).toBe(202);
    await running.tick();
    await vi.waitFor(async () => {
      expect((await s.submit("b", "b", "other")).status).toBe(429);
    });
    await running.stop();
  });
  it("leaves submissions unchanged without quota", async () => {
    const s = await setup(driver);
    for (const id of ["a", "b", "c"])
      expect((await s.submit(id)).status).toBe(202);
  });
});
