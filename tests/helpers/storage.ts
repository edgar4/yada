import knex from "knex";
import { afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStorage, type StorageConfig } from "../../src/storage/index.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
export const drivers = [
  "sqlite",
  ...(process.env["YADA_TEST_POSTGRES_URL"] ? ["postgres" as const] : []),
  ...(process.env["YADA_TEST_MYSQL_URL"] ? ["mysql" as const] : []),
] as const;
export async function storageFixture(driver: (typeof drivers)[number]) {
  const dir = await mkdtemp(join(tmpdir(), "yada-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const config: StorageConfig =
    driver === "sqlite"
      ? {
          driver,
          filename: join(dir, "db.sqlite"),
          encryptionKey: "ab".repeat(32),
        }
      : {
          driver,
          url:
            process.env[
              driver === "postgres"
                ? "YADA_TEST_POSTGRES_URL"
                : "YADA_TEST_MYSQL_URL"
            ] ?? "",
          encryptionKey: "ab".repeat(32),
        };
  if (config.driver !== "sqlite") {
    const original = config.url;
    const name = "yada_" + randomUUID().replaceAll("-", "");
    const admin = () =>
      knex({
        client: config.driver === "postgres" ? "pg" : "mysql2",
        connection: original,
      });
    const database = admin();
    try {
      await database.raw("CREATE DATABASE ??", [name]);
    } finally {
      await database.destroy();
    }
    const url = new URL(original);
    url.pathname = "/" + name;
    config.url = url.href;
    cleanups.push(async () => {
      const database = admin();
      try {
        await database.raw("DROP DATABASE ??", [name]);
      } finally {
        await database.destroy();
      }
    });
  }
  let storage = await createStorage(config);
  cleanups.push(() => storage.close());
  return {
    get storage() {
      return storage;
    },
    config,
    identity: { actorId: randomUUID(), tenantId: randomUUID() },
    reopen: async () => {
      await storage.close();
      storage = await createStorage(config);
      return storage;
    },
  };
}
