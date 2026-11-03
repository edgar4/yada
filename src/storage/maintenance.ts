import type { Knex } from "knex";
import { z } from "zod";
import { backfillRecords, openDatabase } from "./database.js";
import { storageConfig, type StorageConfig } from "./config.js";
import { storageCipher } from "./crypto.js";
const backupSchema = z.strictObject({
  version: z.literal(1),
  records: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      value: z.string(),
      revision: z.number().int().positive(),
      kind: z.string().nullable(),
    }),
  ),
});
export type StorageBackup = z.infer<typeof backupSchema>;
function maintenanceConfig(config: StorageConfig) {
  const settings = storageConfig.parse(config);
  if (settings.driver === "sqlite" && settings.filename === ":memory:")
    throw new Error(
      "Storage maintenance requires a persistent SQLite database",
    );
  return settings;
}
const batchSize = 100;
const rowsSchema = backupSchema.shape.records;
async function* recordBatches(db: Knex) {
  for (let after = ""; ;) {
    const rows = rowsSchema.parse(
      await db("yada_records")
        .select("id", "value", "revision", "kind")
        .where("id", ">", after)
        .orderBy("id")
        .limit(batchSize),
    );
    const last = rows.at(-1);
    if (!last) return;
    yield rows;
    after = last.id;
  }
}
export async function* streamBackup(config: StorageConfig) {
  const db = await openDatabase(maintenanceConfig(config));
  try {
    yield* recordBatches(db);
  } finally {
    await db.destroy();
  }
}
export async function backupStorage(
  config: StorageConfig,
): Promise<StorageBackup> {
  const records: StorageBackup["records"] = [];
  for await (const batch of streamBackup(config)) records.push(...batch);
  return { version: 1, records };
}
export async function restoreStorage(
  config: StorageConfig,
  backup: StorageBackup,
): Promise<void> {
  const parsed = backupSchema.parse(backup);
  const settings = maintenanceConfig(config);
  const cipher = storageCipher(
    settings.encryptionKey,
    settings.previousEncryptionKeys,
  );
  for (const row of parsed.records) cipher.open(row.id, row.value);
  const db = await openDatabase(settings);
  try {
    await db.transaction(async (tx) => {
      const existing: unknown = await tx("yada_records").first();
      if (existing) throw new Error("Restore requires an empty database");
      for (const row of parsed.records) await tx("yada_records").insert(row);
    });
    await backfillRecords(db, settings);
  } finally {
    await db.destroy();
  }
}
export async function rotateStorageKey(
  config: StorageConfig,
  newKey: string,
): Promise<void> {
  const settings = maintenanceConfig(config);
  storageConfig.parse({ ...settings, encryptionKey: newKey });
  const cipher = storageCipher(newKey, [
    settings.encryptionKey,
    ...settings.previousEncryptionKeys,
  ]);
  const db = await openDatabase(settings);
  try {
    for await (const rows of recordBatches(db))
      await db.transaction(async (tx) => {
        for (const row of rows) {
          if (cipher.isCurrent(row.value)) continue;
          const updated = await tx("yada_records")
            .where({ id: row.id, revision: row.revision })
            .update({
              value: cipher.seal(row.id, cipher.open(row.id, row.value)),
              revision: row.revision + 1,
            });
          if (updated !== 1)
            throw new Error("Storage changed during maintenance; rerun");
        }
      });
  } finally {
    await db.destroy();
  }
}
