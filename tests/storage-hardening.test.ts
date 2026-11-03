import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { drivers, storageFixture } from "./helpers/storage.js";
import { storageCipher } from "../src/storage/crypto.js";
import {
  StorageConflict,
  isRetryable,
  recordStore,
} from "../src/storage/records.js";
import {
  backfillRecords,
  migrateDatabase,
  openDatabase,
} from "../src/storage/database.js";
import { conversationKey } from "../src/storage/conversations.js";
import { createStorage } from "../src/storage/index.js";
import {
  backupStorage,
  rotateStorageKey,
  streamBackup,
} from "../src/storage/maintenance.js";
import { RunLeaseError } from "../src/storage/runs.js";

const first = "ab".repeat(32);
const second = "cd".repeat(32);
const input = (id: string) => ({ id, profileId: "v1", input: `Hello ${id}` });
const done = {
  event: { type: "completed" as const, text: "ok" },
  outcome: { status: "completed" as const, text: "ok" },
};

it("treats lock and serialization errors as retryable conflicts", () => {
  expect(isRetryable(new StorageConflict())).toBe(true);
  for (const error of [
    { code: "40001" },
    { code: "40P01" },
    { errno: 1213 },
    { errno: 1205 },
  ])
    expect(isRetryable(error)).toBe(true);
  expect(isRetryable(new Error("other"))).toBe(false);
});

describe("encryption envelopes", () => {
  it("writes key ids, reads v1, and reads previous keys", () => {
    const v1 = (id: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(first, "hex"),
        iv,
      );
      cipher.setAAD(Buffer.from(id));
      const data = Buffer.concat([cipher.update('"old"'), cipher.final()]);
      return ["v1", iv, cipher.getAuthTag(), data]
        .map((part) =>
          typeof part === "string" ? part : part.toString("base64"),
        )
        .join(".");
    };
    expect(storageCipher(first).open("id", v1("id"))).toBe("old");
    expect(storageCipher(second, [first]).open("id", v1("id"))).toBe("old");
    const sealed = storageCipher(first).seal("id", "new");
    expect(sealed).toMatch(/^v2\.[0-9a-f]{8}\./);
    expect(storageCipher(second, [first]).open("id", sealed)).toBe("new");
    expect(() => storageCipher(second).open("id", sealed)).toThrow();
    expect(storageCipher(second, [first]).isCurrent(sealed)).toBe(false);
  });
});

for (const driver of drivers)
  describe(`${driver} storage hardening`, () => {
    it("fences terminal writes and retries by run lease", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      const stale = { runId: JSON.stringify(["chat", "one"]), token: "stale" };
      await expect(
        s.storage.jobs.update(
          s.identity,
          "chat",
          "one",
          done.event,
          done.outcome,
          stale,
        ),
      ).rejects.toBeInstanceOf(RunLeaseError);
      await expect(
        s.storage.jobs.retry(s.identity, "chat", "one", stale),
      ).rejects.toBeInstanceOf(RunLeaseError);
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
      ).toBe("queued");
    });

    it("does not copy history into jobs and retires old terminal jobs", async () => {
      const s = await storageFixture(driver);
      for (let index = 0; index < 23; index++) {
        const id = `job-${String(index)}`;
        await s.storage.jobs.submit(s.identity, "chat", input(id));
        await s.storage.jobs.update(
          s.identity,
          "chat",
          id,
          done.event,
          done.outcome,
        );
      }
      const db = await openDatabase(s.config);
      try {
        const raw = (
          await recordStore(db, s.config.encryptionKey).read(
            conversationKey(s.identity, "chat"),
          )
        )?.value as { jobs: Record<string, unknown>[] };
        expect(raw.jobs).toHaveLength(20);
        expect(raw.jobs[0]).toMatchObject({ id: "job-3" });
        expect(raw.jobs.at(-1)?.["events"]).not.toEqual([]);
        expect(raw.jobs.at(-1)).not.toHaveProperty("history");
      } finally {
        await db.destroy();
      }
      const last = await s.storage.jobs.load(s.identity, "chat", "job-22");
      expect(last?.history).toHaveLength(44);
      expect(last).not.toHaveProperty("historyLength");
      await expect(
        s.storage.jobs.submit(s.identity, "chat", input("job-0")),
      ).rejects.toThrow();
      expect(
        await s.storage.jobs.load(s.identity, "chat", "job-0"),
      ).toBeUndefined();
      await s.storage.retention.eraseConversation(s.identity, "chat");
      const left = await openDatabase(s.config);
      try {
        expect(await left("yada_records").where({ kind: "retired" })).toEqual(
          [],
        );
      } finally {
        await left.destroy();
      }
    });

    it("lists only the caller's conversations by indexed owner with cursors", async () => {
      const s = await storageFixture(driver);
      const other = { tenantId: "t2", actorId: "a2" };
      for (let index = 0; index < 5; index++)
        await s.storage.jobs.submit(
          s.identity,
          `c${String(index)}`,
          input("r"),
        );
      await s.storage.jobs.submit(other, "x", input("r"));
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await s.storage.conversations.list(s.identity, after, 2);
        seen.push(...page.conversations.map((item) => item.id));
        after = page.next;
      } while (after);
      expect(seen.sort()).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    });

    it("backfills owner scope and keeps legacy retired runs blocked after prune", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "chat", input("one"));
      const db = await openDatabase(s.config);
      try {
        await db("yada_records").update({ scope: null });
        await backfillRecords(db, s.config);
        expect(await db("yada_records").whereNull("scope")).toEqual([]);
      } finally {
        await db.destroy();
      }
      expect(
        (await s.storage.conversations.list(s.identity)).conversations,
      ).toHaveLength(1);
      await s.storage.jobs.update(
        s.identity,
        "chat",
        "one",
        done.event,
        done.outcome,
      );
      const legacy = await openDatabase(s.config);
      try {
        const records = recordStore(legacy, s.config.encryptionKey);
        const key = conversationKey(s.identity, "chat");
        const record = await records.read(key);
        await records.write(
          key,
          { ...(record?.value as object), retiredRuns: ["old"] },
          record?.revision ?? 0,
        );
      } finally {
        await legacy.destroy();
      }
      await s.storage.jobs.prune(s.identity, "chat", Date.now() + 1);
      for (const id of ["old", "one"])
        await expect(
          s.storage.jobs.submit(s.identity, "chat", input(id)),
        ).rejects.toThrow();
    });

    it("splits migration from open", async () => {
      const s = await storageFixture(driver);
      const plain = await openDatabase(s.config, { migrate: false });
      await plain.destroy();
      await migrateDatabase(s.config);
      const storage = await createStorage(s.config, { migrate: false });
      await storage.close();
    });

    it("rotates keys in batches, resumes, and streams backups", async () => {
      const s = await storageFixture(driver);
      for (let index = 0; index < 205; index++)
        await s.storage.conversations.save(
          s.identity,
          `chat-${String(index)}`,
          [{ role: "user", content: "hi" }],
          0,
        );
      const batches: number[] = [];
      for await (const batch of streamBackup(s.config))
        batches.push(batch.length);
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.every((size) => size <= 100)).toBe(true);
      await rotateStorageKey(s.config, second);
      const rotated = { ...s.config, encryptionKey: second };
      await rotateStorageKey(rotated, second);
      const storage = await createStorage({
        ...s.config,
        encryptionKey: second,
      });
      try {
        expect(
          (await storage.conversations.load(s.identity, "chat-204"))?.messages,
        ).toHaveLength(1);
      } finally {
        await storage.close();
      }
      expect((await backupStorage(rotated)).records).toHaveLength(205);
    });

    it("re-encrypts on write while reading previous keys", async () => {
      const s = await storageFixture(driver);
      await s.storage.conversations.save(s.identity, "chat", [], 0);
      const storage = await createStorage({
        ...s.config,
        encryptionKey: second,
        previousEncryptionKeys: [first],
      });
      try {
        const loaded = await storage.conversations.load(s.identity, "chat");
        await storage.conversations.save(
          s.identity,
          "chat",
          [{ role: "user", content: "hi" }],
          loaded?.revision ?? 0,
        );
      } finally {
        await storage.close();
      }
      const only = await createStorage({ ...s.config, encryptionKey: second });
      try {
        expect(
          (await only.conversations.load(s.identity, "chat"))?.messages,
        ).toHaveLength(1);
      } finally {
        await only.close();
      }
    });
  });
