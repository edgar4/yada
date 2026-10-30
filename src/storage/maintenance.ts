import { z } from "zod";
import { openDatabase } from "./database.js";
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
export async function backupStorage(
  config: StorageConfig,
): Promise<StorageBackup> {
  const db = await openDatabase(maintenanceConfig(config));
  try {
    const rows: unknown = await db("yada_records").select(
      "id",
      "value",
      "revision",
      "kind",
    );
    return backupSchema.parse({ version: 1, records: rows });
  } finally {
    await db.destroy();
  }
}
export async function restoreStorage(
  config: StorageConfig,
  backup: StorageBackup,
): Promise<void> {
  const parsed = backupSchema.parse(backup);
  const settings = maintenanceConfig(config);
  const cipher = storageCipher(settings.encryptionKey);
  for (const row of parsed.records) cipher.open(row.id, row.value);
  const db = await openDatabase(settings);
  try {
    await db.transaction(async (tx) => {
      const existing: unknown = await tx("yada_records").first();
      if (existing) throw new Error("Restore requires an empty database");
      for (const row of parsed.records) await tx("yada_records").insert(row);
    });
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
  const previous = storageCipher(settings.encryptionKey);
  const next = storageCipher(newKey);
  const db = await openDatabase(settings);
  try {
    await db.transaction(async (tx) => {
      const rows = z
        .array(backupSchema.shape.records.element)
        .parse(
          await tx("yada_records").select("id", "value", "revision", "kind"),
        );
      for (const row of rows) {
        const value = previous.open(row.id, row.value);
        const updated = await tx("yada_records")
          .where({ id: row.id, revision: row.revision })
          .update({
            value: next.seal(row.id, value),
            revision: row.revision + 1,
          });
        if (updated !== 1)
          throw new Error("Storage changed during maintenance");
      }
    });
  } finally {
    await db.destroy();
  }
}
