import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createStorage,
  StorageConflict,
  storageConfigFromEnv,
  type StorageConfig,
  type YadaStorage,
} from "../src/index.js";
const key = "ab".repeat(32);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const drivers = [
  "sqlite",
  ...(process.env["YADA_TEST_POSTGRES_URL"] ? (["postgres"] as const) : []),
  ...(process.env["YADA_TEST_MYSQL_URL"] ? (["mysql"] as const) : []),
] as const;
for (const driver of drivers)
  describe(`${driver} storage conformance`, () => {
    async function setup() {
      const dir = await mkdtemp(join(tmpdir(), "yada-storage-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const config: StorageConfig =
        driver === "sqlite"
          ? { driver, filename: join(dir, "test.sqlite"), encryptionKey: key }
          : {
              driver: driver,
              url:
                process.env[
                  driver === "postgres"
                    ? "YADA_TEST_POSTGRES_URL"
                    : "YADA_TEST_MYSQL_URL"
                ] ?? "",
              encryptionKey: key,
            };
      let store: YadaStorage = await createStorage(config);
      cleanups.push(() => store.close());
      const identity = { actorId: randomUUID(), tenantId: randomUUID() };
      return {
        get store() {
          return store;
        },
        config,
        identity,
        reopen: async () => {
          await store.close();
          store = await createStorage(config);
          return store;
        },
      };
    }
    it("persists conversations across reopen and isolates ownership", async () => {
      const s = await setup();
      expect(
        await s.store.conversations.load(s.identity, "one"),
      ).toBeUndefined();
      await s.store.conversations.save(
        s.identity,
        "one",
        [{ role: "user", content: "Hello" }],
        0,
      );
      await s.reopen();
      expect(await s.store.conversations.load(s.identity, "one")).toEqual({
        revision: 1,
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(
        await s.store.conversations.load(
          { ...s.identity, actorId: "other" },
          "one",
        ),
      ).toBeUndefined();
      expect(
        await s.store.conversations.load(
          { ...s.identity, tenantId: "other" },
          "one",
        ),
      ).toBeUndefined();
    });
    it("allows only one concurrent revision update", async () => {
      const s = await setup();
      await s.store.conversations.save(s.identity, "one", [], 0);
      const results = await Promise.allSettled([
        s.store.conversations.save(
          s.identity,
          "one",
          [{ role: "user", content: "A" }],
          1,
        ),
        s.store.conversations.save(
          s.identity,
          "one",
          [{ role: "user", content: "B" }],
          1,
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      await expect(
        s.store.conversations.save(s.identity, "one", [], 0),
      ).rejects.toBeInstanceOf(StorageConflict);
    });
    it("merges OAuth fields and atomically consumes state once", async () => {
      const s = await setup();
      const id = JSON.stringify(s.identity);
      await Promise.all([
        s.store.oauth.update(id, {
          tokens: {
            access_token: "private-token",
            token_type: "Bearer",
            issuer: "https://auth.example",
          },
        }),
        s.store.oauth.update(id, {
          pending: {
            state: "state",
            verifier: "private-verifier",
            expiresAt: 1000,
          },
        }),
      ]);
      await s.reopen();
      expect((await s.store.oauth.load(id))?.tokens?.issuer).toBe(
        "https://auth.example",
      );
      expect(await s.store.oauth.consumePending(id, "wrong")).toBeUndefined();
      const pending = await Promise.all([
        s.store.oauth.consumePending(id, "state"),
        s.store.oauth.consumePending(id, "state"),
      ]);
      expect(pending.filter(Boolean)).toHaveLength(1);
      await s.store.oauth.update(id, { tokens: undefined });
      expect((await s.store.oauth.load(id))?.tokens).toBeUndefined();
      expect(await s.store.oauth.load("other")).toBeUndefined();
    });
    it("rejects incorrect encryption keys without destroying data", async () => {
      const s = await setup();
      await s.store.conversations.save(s.identity, "one", [], 0);
      const wrong = await createStorage({
        ...s.config,
        encryptionKey: "cd".repeat(32),
      });
      try {
        await expect(
          wrong.conversations.load(s.identity, "one"),
        ).rejects.toThrow();
      } finally {
        await wrong.close();
      }
      expect(
        (await s.store.conversations.load(s.identity, "one"))?.revision,
      ).toBe(1);
    });
    it("validates revisions and does not store plaintext", async () => {
      const s = await setup();
      await expect(
        s.store.conversations.save(s.identity, "one", [], -1),
      ).rejects.toThrow();
      await s.store.oauth.update("secret-key", {
        tokens: { access_token: "private-token", token_type: "Bearer" },
      });
      await s.reopen();
      if (s.config.driver === "sqlite") {
        expect(
          (await readFile(s.config.filename ?? "")).includes("private-token"),
        ).toBe(false);
      }
    });
  });
it("defaults to SQLite and validates configuration", () => {
  expect(storageConfigFromEnv({ YADA_STORAGE_KEY: key })).toEqual({
    driver: "sqlite",
    filename: "yada.sqlite",
    encryptionKey: key,
  });
  expect(() => storageConfigFromEnv({})).toThrow("Invalid storage");
  expect(() =>
    storageConfigFromEnv({
      YADA_STORAGE_DRIVER: "mysql",
      YADA_STORAGE_KEY: key,
      YADA_STORAGE_URL: "https://invalid",
    }),
  ).toThrow();
});
