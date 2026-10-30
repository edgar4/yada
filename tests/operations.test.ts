import { describe, expect, it } from "vitest";
import { drivers, storageFixture } from "./helpers/storage.js";
import {
  backupStorage,
  restoreStorage,
  rotateStorageKey,
} from "../src/storage/maintenance.js";
import { createStorage } from "../src/storage/index.js";
import { run } from "../src/core/runtime.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { contextWindow } from "../src/core/limits.js";
import { createWorker } from "../src/service/worker.js";
import type { RunCheckpoint } from "../src/core/checkpoint.js";
it("rejects in-memory SQLite for all config-based maintenance APIs", async () => {
  const config = {
    driver: "sqlite" as const,
    filename: ":memory:",
    encryptionKey: "ab".repeat(32),
  };
  const source = await createStorage(config);
  const identity = { actorId: "actor", tenantId: "tenant" };
  try {
    await source.conversations.save(identity, "chat", [], 0);
    for (const operation of [
      () => backupStorage(config),
      () => restoreStorage(config, { version: 1, records: [] }),
      () => rotateStorageKey(config, "cd".repeat(32)),
    ])
      await expect(operation()).rejects.toThrow("persistent SQLite database");
    expect(await source.conversations.load(identity, "chat")).toBeDefined();
  } finally {
    await source.close();
  }
});
for (const driver of drivers)
  describe(`${driver} operations`, () => {
    it("restores encrypted backups and rotates keys without exposing plaintext", async () => {
      const source = await storageFixture(driver);
      const target = await storageFixture(driver);
      await source.storage.conversations.save(
        source.identity,
        "chat",
        [{ role: "user", content: "private message" }],
        0,
      );
      const backup = await backupStorage(source.config);
      expect(JSON.stringify(backup)).not.toContain("private message");
      await restoreStorage(target.config, backup);
      expect(
        (await target.storage.conversations.load(source.identity, "chat"))
          ?.messages[0]?.content,
      ).toBe("private message");
      await expect(restoreStorage(target.config, backup)).rejects.toThrow(
        "empty",
      );
      await expect(
        restoreStorage(
          { ...source.config, encryptionKey: "cd".repeat(32) },
          backup,
        ),
      ).rejects.toThrow();
      await rotateStorageKey(target.config, "cd".repeat(32));
      await expect(
        target.storage.conversations.load(source.identity, "chat"),
      ).rejects.toThrow();
      const rotated = await createStorage({
        ...target.config,
        encryptionKey: "cd".repeat(32),
      });
      try {
        expect(
          (await rotated.conversations.load(source.identity, "chat"))?.messages,
        ).toHaveLength(1);
      } finally {
        await rotated.close();
      }
    });
    it("erases completed execution data and blocks reuse without losing active jobs", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "private",
      });
      await expect(
        s.storage.retention.eraseConversation(s.identity, "chat"),
      ).rejects.toThrow("unfinished");
      const worker = createWorker({
        storage: s.storage,
        profiles: {
          v1: {
            provider: createFakeProvider(() => ({
              content: "secret",
              toolCalls: [],
              finishReason: "stop",
            })),
            tools: [],
            system: "Help",
          },
        },
      });
      await worker.tick();
      await worker.stop();
      await s.storage.retention.eraseConversation(s.identity, "chat");
      await s.storage.retention.eraseConversation(s.identity, "chat");
      expect(
        await s.storage.conversations.load(s.identity, "chat"),
      ).toBeUndefined();
      expect(
        await s.storage.runs.load(s.identity, JSON.stringify(["chat", "one"])),
      ).toBeUndefined();
      await expect(
        s.storage.jobs.submit(s.identity, "chat", {
          id: "two",
          profileId: "v1",
          input: "reuse",
        }),
      ).rejects.toThrow("erased");
    });
  });
it("reserves cost before calls, persists usage and enforces context boundaries", async () => {
  const provider = createFakeProvider(() => ({
    content: "Done",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  }));
  const options = {
    provider,
    tools: [],
    identity: { actorId: "a", tenantId: "t" },
    input: "Hello",
    system: "Help",
    signal: AbortSignal.timeout(3000),
  };
  const saved: RunCheckpoint[] = [];
  expect(
    await run({
      ...options,
      limits: { maxCostMicros: 10, costPerCallMicros: 11 },
    }),
  ).toEqual({ status: "failed", code: "limit" });
  expect(provider.requests).toHaveLength(0);
  expect(await run({ ...options, limits: { maxContextChars: 2 } })).toEqual({
    status: "failed",
    code: "limit",
  });
  expect(
    await run({
      ...options,
      limits: { maxCostMicros: 10, costPerCallMicros: 10 },
      persist: (state) => {
        saved.push(state);
        return Promise.resolve();
      },
    }),
  ).toEqual({ status: "completed", text: "Done" });
  expect(saved.at(-1)).toMatchObject({
    reservedCostMicros: 10,
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  await expect(
    run({ ...options, limits: { maxCostMicros: 10 } }),
  ).rejects.toThrow();
  const checkpoint = {
    ...saved[0],
    version: 1 as const,
    messages: [],
    pending: [],
    calls: 0,
    rounds: 1,
    reservedCostMicros: 10,
  };
  expect(
    await run({
      ...options,
      checkpoint,
      limits: { maxCostMicros: 10, costPerCallMicros: 10 },
    }),
  ).toEqual({ status: "failed", code: "limit" });
});
it("trims history only at user turn boundaries", () => {
  const history = [
    { role: "user" as const, content: "A".repeat(1000) },
    { role: "assistant" as const, content: "old", toolCalls: [] },
    { role: "user" as const, content: "new" },
    { role: "assistant" as const, content: "answer", toolCalls: [] },
  ];
  expect(contextWindow(history, 200)).toEqual(history.slice(2));
  expect(contextWindow(history, 0)).toEqual([]);
  expect(() => contextWindow(history, -1)).toThrow();
});
it("rolls back invalid restores and erases pruned run references", async () => {
  const source = await storageFixture("sqlite");
  const target = await storageFixture("sqlite");
  await source.storage.conversations.save(source.identity, "a", [], 0);
  const backup = await backupStorage(source.config);
  await expect(
    restoreStorage(target.config, {
      ...backup,
      records: [...backup.records, ...backup.records],
    }),
  ).rejects.toThrow();
  expect((await backupStorage(target.config)).records).toHaveLength(0);
  await restoreStorage(target.config, backup);
  await source.storage.jobs.submit(source.identity, "chat", {
    id: "one",
    profileId: "v1",
    input: "Hello",
  });
  const worker = createWorker({
    storage: source.storage,
    profiles: {
      v1: {
        provider: createFakeProvider(() => ({
          content: "Done",
          toolCalls: [],
          finishReason: "stop",
        })),
        tools: [],
        system: "Help",
      },
    },
  });
  await worker.tick();
  await worker.stop();
  await source.storage.jobs.prune(source.identity, "chat", Date.now() + 1);
  await expect(
    source.storage.jobs.submit(source.identity, "chat", {
      id: "one",
      profileId: "v1",
      input: "Hello",
    }),
  ).rejects.toThrow();
  await source.storage.retention.eraseConversation(source.identity, "chat");
  expect(
    await source.storage.runs.load(
      source.identity,
      JSON.stringify(["chat", "one"]),
    ),
  ).toBeUndefined();
});
