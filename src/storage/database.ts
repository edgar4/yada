import { knex, type Knex } from "knex";
import { storageConfig, type StorageConfig } from "./config.js";
export async function openDatabase(config: StorageConfig): Promise<Knex> {
  const options = storageConfig.parse(config);
  const db = knex({
    client:
      options.driver === "sqlite"
        ? "better-sqlite3"
        : options.driver === "postgres"
          ? "pg"
          : "mysql2",
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
    await db.migrate.latest({
      migrationSource: {
        getMigrations: () => Promise.resolve(["001_records"]),
        getMigrationName: (name) => String(name),
        getMigration: () =>
          Promise.resolve({
            up: async (tx: Knex) => {
              await tx.schema.createTable("yada_records", (table) => {
                table.string("id", 64).primary();
                table.text("value", "longtext").notNullable();
                table.integer("revision").notNullable();
              });
            },
            down: async (tx: Knex) => {
              await tx.schema.dropTable("yada_records");
            },
          }),
      },
    });
    return db;
  } catch (error) {
    await db.destroy();
    throw error;
  }
}
