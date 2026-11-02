import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createHandler } from "../src/service/http.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import type { QuotaOptions } from "../src/service/quota.js";
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
  it("leaves submissions unchanged without quota", async () => {
    const s = await setup(driver);
    for (const id of ["a", "b", "c"])
      expect((await s.submit(id)).status).toBe(202);
  });
});
