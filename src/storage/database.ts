import { createHash } from "node:crypto";
import knex, { type Knex } from "knex";
import { z } from "zod";
import { knexClient } from "../optional.js";
import { isTerminal } from "../service/terminal.js";
import { storageConfig, type StorageConfig } from "./config.js";
import { storageCipher } from "./crypto.js";
import { conversationKey } from "./conversations.js";
import { conversationStateSchema } from "./jobs.js";
import { scopeFor } from "./records.js";
const rowSchema = z.array(
  z.object({
    id: z.string(),
    value: z.string(),
    revision: z.number(),
    kind: z.string().nullable(),
    scope: z.string().nullable().optional(),
  }),
);
const retiredSchema = z.object({ key: z.string() });
export async function backfillRecords(db: Knex, config: StorageConfig) {
  const options = storageConfig.parse(config);
  const cipher = storageCipher(
    options.encryptionKey,
    options.previousEncryptionKeys,
  );
  const stale = [
    (query: Knex.QueryBuilder) => query.whereNull("kind"),
    (query: Knex.QueryBuilder) =>
      query.where({ kind: "conversation" }).where((nulls) => {
        void nulls.whereNull("active").orWhereNull("updated_at");
      }),
    (query: Knex.QueryBuilder) =>
      query
        .whereIn("kind", ["conversation", "retired", "grant"])
        .whereNull("scope"),
    (query: Knex.QueryBuilder) => query.where({ kind: "legacy" }),
  ];
  for (const condition of stale)
    for (let after = ""; ;) {
      const rows = rowSchema.parse(
        await condition(db("yada_records"))
          .andWhere("id", ">", after)
          .orderBy("id")
          .limit(100),
      );
      const last = rows.at(-1);
      if (!last) break;
      after = last.id;
      for (const row of rows) {
        const value = cipher.open(row.id, row.value);
        if (value === true) {
          await db("yada_records")
            .where({ id: row.id, revision: row.revision })
            .delete();
          continue;
        }
        if (row.kind === "legacy") continue;
        const state = conversationStateSchema.safeParse(value);
        const conversation =
          row.kind === "conversation" || Array.isArray(value) || state.success;
        const kind = row.kind ?? (conversation ? "conversation" : "legacy");
        const key = state.success
          ? conversationKey(state.data.identity, state.data.id)
          : retiredSchema.safeParse(value).data?.key;
        await db("yada_records")
          .where({ id: row.id, revision: row.revision })
          .update({
            kind,
            ...(kind === "conversation" ||
            kind === "retired" ||
            kind === "grant"
              ? { scope: (key && scopeFor(key)) ?? "" }
              : {}),
            ...(kind === "conversation"
              ? { updated_at: state.data?.jobs.at(-1)?.updatedAt ?? 0 }
              : {}),
            active:
              state.success &&
              state.data.jobs.some((job) => !isTerminal(job.status)),
          });
      }
    }
  await db("yada_records")
    .where({
      id: createHash("sha256")
        .update(JSON.stringify(["job_queue"]))
        .digest("hex"),
    })
    .delete();
}
export async function openDatabase(
  config: StorageConfig,
  { migrate = true }: { migrate?: boolean } = {},
): Promise<Knex> {
  const options = storageConfig.parse(config);
  const db = knex({
    client: knexClient(options.driver),
    connection:
      options.driver === "sqlite"
        ? { filename: options.filename }
        : options.url,
    useNullAsDefault: true,
    pool: { min: 0, max: options.driver === "sqlite" ? 1 : 5 },
  });
  try {
    if (options.driver === "sqlite") {
      await db.raw("PRAGMA journal_mode = WAL");
      await db.raw("PRAGMA busy_timeout = 5000");
    }
    if (!migrate) return db;
    await db.migrate.latest({
      migrationSource: {
        getMigrations: () =>
          Promise.resolve([
            "001_records",
            "002_discovery",
            "003_active",
            "004_scope",
            "005_updated",
          ]),
        getMigrationName: (name) => String(name),
        getMigration: (name) =>
          Promise.resolve({
            up: async (tx: Knex) => {
              if (name === "005_updated") {
                await tx.schema.alterTable("yada_records", (table) => {
                  table.bigInteger("updated_at");
                  table.index(["scope", "updated_at", "id"]);
                });
                return;
              }
              if (name === "004_scope") {
                await tx.schema.alterTable("yada_records", (table) => {
                  table.string("scope", 64);
                  table.index(["scope", "id"]);
                });
                return;
              }
              if (name === "003_active") {
                await tx.schema.alterTable("yada_records", (table) => {
                  table.boolean("active");
                  table.index(["active", "id"]);
                });
                return;
              }
              if (name === "002_discovery") {
                await tx.schema.alterTable("yada_records", (table) => {
                  table.string("kind", 40).index();
                });
                return;
              }
              await tx.schema.createTable("yada_records", (table) => {
                table.string("id", 64).primary();
                table.text("value", "longtext").notNullable();
                table.integer("revision").notNullable();
              });
            },
            down: async (tx: Knex) => {
              if (name === "005_updated") {
                await tx.schema.alterTable("yada_records", (table) => {
                  table.dropIndex(["scope", "updated_at", "id"]);
                  table.dropColumn("updated_at");
                });
                return;
              }
              if (name === "004_scope") {
                await tx.schema.alterTable("yada_records", (table) => {
                  table.dropIndex(["scope", "id"]);
                  table.dropColumn("scope");
                });
                return;
              }
              if (name === "003_active") {
                await tx.schema.alterTable("yada_records", (table) => {
                  table.dropIndex(["active", "id"]);
                  table.dropColumn("active");
                });
                return;
              }
              if (name === "002_discovery") {
                await tx.schema.alterTable("yada_records", (table) => {
                  table.dropColumn("kind");
                });
                return;
              }
              await tx.schema.dropTable("yada_records");
            },
          }),
      },
    });
    await backfillRecords(db, options);
    return db;
  } catch (error) {
    await db.destroy();
    throw error;
  }
}
export async function migrateDatabase(config: StorageConfig): Promise<void> {
  await (await openDatabase(config)).destroy();
}
