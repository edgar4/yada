import { describe, expect, it, vi } from "vitest";
import { storageFixture } from "./helpers/storage.js";
import { createWorker, type AgentProfile } from "../src/service/worker.js";
import { createHandler } from "../src/service/http.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { openDatabase } from "../src/storage/database.js";
import { conversationKey } from "../src/storage/conversations.js";
import { recordStore } from "../src/storage/records.js";
import type { ProviderResult } from "../src/core/contracts.js";
import type { QuotaOptions } from "../src/service/quota.js";
import { writeTool } from "../src/index.js";
import { z } from "zod";

const usage: NonNullable<ProviderResult["usage"]> = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 400,
  cacheWriteTokens: 100,
  serverToolCalls: 2,
};
const reply = (text = "done"): ProviderResult => ({
  content: text,
  toolCalls: [],
  finishReason: "stop",
  usage,
});
const input = (id: string) => ({ id, profileId: "p", input: "Hi" });
const profile = (provider: AgentProfile["provider"]): AgentProfile => ({
  provider,
  tools: [],
  system: "s",
});
const handlerFor = (
  s: Awaited<ReturnType<typeof storageFixture>>,
  extra: Partial<Parameters<typeof createHandler>[0]> = {},
) =>
  createHandler({
    storage: s.storage,
    origins: [],
    authenticate: () => Promise.resolve(s.identity),
    authorizeProfile: () => Promise.resolve(true),
    ...extra,
  });
const runUrl = (conversation: string, run: string) =>
  `http://x/v1/conversations/${conversation}/runs/${run}`;

describe("usage events", () => {
  it("stores cached usage so the run stays readable through storage and HTTP", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "c", input("r"));
    const worker = createWorker({
      storage: s.storage,
      profiles: { p: profile(createFakeProvider(() => reply())) },
    });
    await worker.tick();
    const job = await s.storage.jobs.load(s.identity, "c", "r");
    expect(job?.status).toBe("completed");
    expect(job?.events.find((event) => event.type === "usage")).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      serverToolCalls: 2,
    });
    const response = await handlerFor(s)(new Request(runUrl("c", "r")));
    expect(response.status).toBe(200);
    await worker.stop();
  });

  it("drops unknown usage fields a custom provider reports", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "c", input("r"));
    const worker = createWorker({
      storage: s.storage,
      profiles: {
        p: profile(
          createFakeProvider(
            () =>
              ({
                ...reply(),
                usage: { ...usage, reasoningTokens: 7 },
              }) as ProviderResult,
          ),
        ),
      },
    });
    await worker.tick();
    const job = await s.storage.jobs.load(s.identity, "c", "r");
    expect(job?.status).toBe("completed");
    expect(
      job?.events.find((event) => event.type === "usage"),
    ).not.toHaveProperty("reasoningTokens");
    await worker.stop();
  });
});

describe("corrupt records", () => {
  const corrupt = async (
    s: Awaited<ReturnType<typeof storageFixture>>,
    conversation: string,
    change: (value: Record<string, unknown>) => unknown,
  ) => {
    const db = await openDatabase(s.config);
    try {
      const records = recordStore(db, s.config.encryptionKey);
      const key = conversationKey(s.identity, conversation);
      const row = await records.read(key);
      await records.write(
        key,
        change(row?.value as Record<string, unknown>),
        row?.revision ?? 0,
        true,
      );
    } finally {
      await db.destroy();
    }
  };
  const badEvent = (value: Record<string, unknown>) => {
    const jobs = value["jobs"] as { events: unknown[] }[];
    jobs[0]?.events.push({
      version: 1,
      sequence: 2,
      type: "usage",
      at: 1,
      futureField: 1,
    });
    return value;
  };

  it("quarantines once, fails the run and keeps other jobs moving", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "bad", input("broken"));
    await s.storage.jobs.submit(s.identity, "good", input("fine"));
    await corrupt(s, "bad", badEvent);
    const onCorrupt = vi.fn();
    const first = await s.storage.jobs.pending("", onCorrupt);
    expect(first.jobs.map((job) => job.conversationId)).toEqual(["good"]);
    expect(onCorrupt).toHaveBeenCalledOnce();
    expect(onCorrupt.mock.calls[0]?.[1]).toMatchObject({
      conversationId: "bad",
      failed: [{ runId: "broken" }],
    });
    await s.storage.jobs.pending("", onCorrupt);
    expect(onCorrupt).toHaveBeenCalledOnce();

    const job = await s.storage.jobs.load(s.identity, "bad", "broken");
    expect(job?.status).toBe("failed");
    expect(job?.outcome).toEqual({ status: "failed", code: "corrupt_record" });
    expect(job?.events.map((event) => event.sequence)).toEqual([1, 2, 3]);

    const { records } = await s.storage.jobs.quarantined();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0]?.value)).toContain("futureField");
    expect(records[0]?.issues.length).toBeGreaterThan(0);
  });

  it("repairs a record the first time a reader reaches it", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "bad", input("broken"));
    await corrupt(s, "bad", badEvent);
    const response = await handlerFor(s)(new Request(runUrl("bad", "broken")));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "failed" });
  });

  it("isolates rows with no recoverable owner and stops reporting them", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "bad", input("broken"));
    await corrupt(s, "bad", () => ({ garbage: true }));
    const onCorrupt = vi.fn();
    await s.storage.jobs.pending("", onCorrupt);
    await s.storage.jobs.pending("", onCorrupt);
    expect(onCorrupt).toHaveBeenCalledOnce();
    expect((await s.storage.jobs.quarantined()).records).toHaveLength(1);
    expect(await s.storage.jobs.load(s.identity, "bad", "broken")).toBe(
      undefined,
    );
  });

  it("skips records it cannot decrypt without touching or blocking", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "bad", input("broken"));
    await s.storage.jobs.submit(s.identity, "good", input("fine"));
    const db = await openDatabase(s.config);
    const id = recordStore(db, s.config.encryptionKey).rowId(
      conversationKey(s.identity, "bad"),
    );
    await db("yada_records").where({ id }).update({ value: "v2.bad.x.y.z" });
    const onCorrupt = vi.fn();
    const page = await s.storage.jobs.pending("", onCorrupt);
    await s.storage.jobs.pending("", onCorrupt);
    expect(page.jobs.map((job) => job.conversationId)).toEqual(["good"]);
    expect(onCorrupt).toHaveBeenCalledOnce();
    const row = (await db("yada_records").where({ id }).first()) as {
      value: string;
      active: unknown;
    };
    expect(row.value).toBe("v2.bad.x.y.z");
    expect(Boolean(row.active)).toBe(true);
    await db.destroy();
  });

  it("erases the quarantined copy with its conversation", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "bad", input("broken"));
    await corrupt(s, "bad", badEvent);
    await s.storage.retention.eraseConversation(s.identity, "bad");
    expect((await s.storage.jobs.quarantined()).records).toEqual([]);
  });

  it("settles held quota and traces once when a worker quarantines", async () => {
    const s = await storageFixture("sqlite");
    const quota: QuotaOptions = {
      costMicros: { limit: 1000, windowMs: 60_000 },
      reserveCostMicros: 1000,
    };
    const handler = handlerFor(s, { quota });
    const submit = (conversation: string, id: string) =>
      handler(
        new Request(`http://x/v1/conversations/${conversation}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input(id)),
        }),
      );
    expect((await submit("bad", "broken")).status).toBe(202);
    await corrupt(s, "bad", badEvent);
    expect((await submit("other", "blocked")).status).toBe(429);
    const traces: string[] = [];
    const worker = createWorker({
      storage: s.storage,
      quota,
      profiles: { p: profile(createFakeProvider(() => reply())) },
      trace: (event) => {
        traces.push(`${event.event}:${event.code ?? event.status}`);
      },
    });
    await worker.tick();
    await worker.tick();
    await vi.waitFor(() => {
      expect(traces).toEqual([
        "record_quarantined:corrupt_record",
        "run_finished:corrupt_record",
      ]);
    });
    expect((await submit("other", "blocked")).status).toBe(202);
    await worker.stop();
  });
});

describe("runtime settings", () => {
  const pricing = (micros: number) => ({
    inputMicrosPer1k: micros,
    outputMicrosPer1k: 0,
  });

  it("resolves function settings once per run and passes run context", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "c", input("r"));
    const provider = vi.fn(() => createFakeProvider(() => reply()));
    const limits = vi.fn(async () => {
      await Promise.resolve();
      return { maxRounds: 3 };
    });
    const worker = createWorker({
      storage: s.storage,
      profiles: { p: { ...profile(provider), limits } },
    });
    await worker.tick();
    expect(provider).toHaveBeenCalledOnce();
    expect(limits).toHaveBeenCalledOnce();
    expect(limits.mock.calls[0]).toMatchObject([
      {
        identity: s.identity,
        conversationId: "c",
        runId: "r",
        profileId: "p",
      },
    ]);
    const run = await s.storage.runs.load(s.identity, '["c","r"]');
    expect(run?.request.limits.maxRounds).toBe(3);
    await worker.stop();
  });

  it("keeps the starting limits and pricing across an approval", async () => {
    const s = await storageFixture("sqlite");
    const handler = handlerFor(s);
    let micros = 1000;
    const quota: QuotaOptions = {
      costMicros: { limit: 1_000_000, windowMs: 60_000 },
    };
    const settle = vi.spyOn(s.storage.quota, "settle");
    let round = 0;
    const adapter = createFakeProvider(() =>
      round++
        ? reply()
        : {
            ...reply(""),
            finishReason: "tool_calls",
            toolCalls: [{ id: "1", name: "act", args: {} }],
          },
    );
    const provider = vi.fn(() => adapter);
    const worker = createWorker({
      storage: s.storage,
      quota,
      profiles: {
        p: {
          provider,
          tools: [
            writeTool({
              name: "act",
              description: "Act",
              input: z.strictObject({}),
              version: "1",
              authorize: () => Promise.resolve(true),
              prepare: () => Promise.resolve({ preview: "Act", version: "1" }),
              execute: () => Promise.resolve("ok"),
              reconcile: () => Promise.resolve(undefined),
            }),
          ],
          system: "s",
          limits: () => ({ pricing: pricing(micros), maxCostMicros: 9e9 }),
        },
      },
    });
    await s.storage.jobs.submit(s.identity, "c", input("r"));
    await worker.tick();
    const waiting = await s.storage.jobs.load(s.identity, "c", "r");
    expect(waiting?.status).toBe("awaiting_approval");
    micros = 999_999;
    const approvalId = waiting?.events.at(-1)?.approvalId ?? "";
    const decided = await handler(
      new Request(`${runUrl("c", "r")}/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      }),
    );
    expect(decided.status).toBe(202);
    await worker.tick();
    await vi.waitFor(async () => {
      expect((await s.storage.jobs.load(s.identity, "c", "r"))?.status).toBe(
        "completed",
      );
    });
    const billed = settle.mock.calls.at(-1)?.[3] ?? 0;
    const stored = await s.storage.runs.load(s.identity, '["c","r"]');
    expect(stored?.request.limits.pricing?.inputMicrosPer1k).toBe(1000);
    expect(billed).toBeLessThan(10_000);
    expect(billed).toBeGreaterThan(0);
    expect(provider).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it("gives a replaced worker the provider the run started with", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "c", input("r"));
    await s.storage.runs.claim(
      s.identity,
      '["c","r"]',
      {
        input: "Hi",
        system: "s",
        profileId: "p",
        provider: "original",
        tools: [],
        maxRounds: 32,
        maxToolCalls: 64,
        limits: {},
        history: [],
      },
      100,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const provider = vi.fn((context: { startedProvider?: string }) => ({
      ...createFakeProvider(() => reply()),
      name: context.startedProvider ?? "new",
    }));
    const worker = createWorker({
      storage: s.storage,
      profiles: { p: profile(provider) },
    });
    await worker.tick();
    expect(provider.mock.calls[0]?.[0].startedProvider).toBe("original");
    expect((await s.storage.jobs.load(s.identity, "c", "r"))?.status).toBe(
      "completed",
    );
    await worker.stop();
  });

  it("keeps getters working with the same snapshot rules", async () => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "c", input("r"));
    let maxRounds = 3;
    const getterProfile: AgentProfile = {
      get provider() {
        return createFakeProvider(() => reply());
      },
      get limits() {
        return { maxRounds };
      },
      tools: [],
      system: "s",
    };
    const worker = createWorker({
      storage: s.storage,
      profiles: { p: getterProfile },
    });
    await worker.tick();
    maxRounds = 9;
    const run = await s.storage.runs.load(s.identity, '["c","r"]');
    expect(run?.request.limits.maxRounds).toBe(3);
    expect((await s.storage.jobs.load(s.identity, "c", "r"))?.status).toBe(
      "completed",
    );
    await worker.stop();
  });

  it("admits and settles with one quota snapshot per run", async () => {
    const s = await storageFixture("sqlite");
    let limit = 1;
    const settings = vi.fn(() => ({
      requests: { limit, windowMs: 60_000 },
      costMicros: { limit: 1_000_000, windowMs: 60_000 },
    }));
    const handler = handlerFor(s, { profiles: { p: { quota: settings } } });
    const post = (conversation: string, id: string) =>
      handler(
        new Request(`http://x/v1/conversations/${conversation}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input(id)),
        }),
      );
    const created = await post("c1", "r1");
    expect(created.status).toBe(202);
    expect(await created.json()).not.toHaveProperty("quota");
    expect((await post("c1", "r1")).status).toBe(202);
    expect(settings).toHaveBeenCalledOnce();
    expect((await post("c2", "r2")).status).toBe(429);
    limit = 5;
    expect((await post("c2", "r2")).status).toBe(202);

    const settle = vi.spyOn(s.storage.quota, "settle");
    limit = 99;
    const worker = createWorker({
      storage: s.storage,
      profiles: {
        p: {
          ...profile(createFakeProvider(() => reply())),
          limits: { pricing: pricing(1000) },
          quota: settings,
        },
      },
    });
    await worker.tick();
    await vi.waitFor(() => {
      expect(settle).toHaveBeenCalled();
    });
    expect(settings.mock.calls.length).toBe(3);
    await worker.stop();
  });

  it("ignores a profile id inherited from Object.prototype", async () => {
    const s = await storageFixture("sqlite");
    const handler = handlerFor(s, { profiles: {} });
    const response = await handler(
      new Request("http://x/v1/conversations/c/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input("r"), profileId: "constructor" }),
      }),
    );
    expect(response.status).toBe(202);
  });
});
