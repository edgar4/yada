import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadDatabase } from "../src/connectors/database.js";
const identity = { actorId: "a", tenantId: "t" };
const signal = () => AbortSignal.timeout(5000);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
async function databaseFixture() {
  const folder = await mkdtemp(join(tmpdir(), "yada-read-"));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const filename = join(folder, "business.sqlite");
  const setup = new Database(filename);
  setup.exec(
    "CREATE TABLE items (tenant TEXT, id TEXT, secret TEXT); INSERT INTO items VALUES ('t','a','private'),('other','a','hidden'),('t','b','private');",
  );
  setup.close();
  const database = createReadDatabase({ driver: "sqlite", filename });
  cleanups.push(() => database.close());
  const options = {
    name: "lookup",
    description: "Lookup",
    input: z.strictObject({ id: z.string() }),
    authorize: () => Promise.resolve(true),
    table: "items",
    columns: ["id"],
    tenantColumn: "tenant",
    filters: { id: "id" },
    values: (args: { id: string }) => ({ id: args.id }),
  };
  return { database, options, filename };
}
it("uses parameterized constrained reads, tenant isolation, column projections, and bounded rows", async () => {
  const { database, options } = await databaseFixture();
  const tool = database.tool(options);
  expect(await tool.execute({ id: "a" }, identity, signal())).toBe(
    '[{"id":"a"}]',
  );
  expect(await tool.execute({ id: "a' OR 1=1 --" }, identity, signal())).toBe(
    "[]",
  );
  expect(
    await tool.execute(
      { id: "a" },
      { ...identity, tenantId: "none" },
      signal(),
    ),
  ).toBe("[]");
  const all = database.tool({ ...options, values: () => ({}), limit: 1 });
  expect(
    JSON.parse(await all.execute({ id: "a" }, identity, signal())),
  ).toHaveLength(1);
  await expect(
    database
      .tool({ ...options, authorize: () => Promise.resolve(false) })
      .execute({ id: "a" }, identity, signal()),
  ).rejects.toThrow("denied");
  await expect(
    tool.execute({ id: "a" }, identity, AbortSignal.abort()),
  ).rejects.toThrow();
  await expect(
    database
      .tool({ ...options, values: () => ({ sql: "DROP TABLE items" }) })
      .execute({ id: "a" }, identity, signal()),
  ).rejects.toThrow("Unreviewed");
  expect(() =>
    database.tool({ ...options, table: "items; DROP TABLE items" }),
  ).toThrow();
  expect(() => database.tool({ ...options, limit: 1001 })).toThrow();
  await database.close();
  expect(await tool.authorize(identity)).toBe(false);
  await expect(tool.execute({ id: "a" }, identity, signal())).rejects.toThrow(
    "denied",
  );
});
it("rejects oversized database output and propagates query errors", async () => {
  const { database, options, filename } = await databaseFixture();
  const setup = new Database(filename);
  setup
    .prepare("UPDATE items SET id = ? WHERE tenant = ?")
    .run("x".repeat(32001), "t");
  setup.close();
  await expect(
    database
      .tool({ ...options, values: () => ({}) })
      .execute({ id: "a" }, identity, signal()),
  ).rejects.toThrow("too large");
  await expect(
    database
      .tool({ ...options, table: "missing" })
      .execute({ id: "a" }, identity, signal()),
  ).rejects.toThrow();
});
