import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { storageCipher } from "./crypto.js";
const rowSchema = z.object({
  value: z.string(),
  revision: z.number().int().nonnegative(),
});
export class StorageConflict extends Error {
  constructor() {
    super("Storage revision conflict");
  }
}
export function recordStore(db: Knex, encryptionKey: string) {
  const cipher = storageCipher(encryptionKey);
  const idFor = (key: string) => createHash("sha256").update(key).digest("hex");
  async function read(key: string) {
    const id = idFor(key);
    const raw: unknown = await db("yada_records").where({ id }).first();
    if (!raw) return undefined;
    const row = rowSchema.parse(raw);
    return { revision: row.revision, value: cipher.open(id, row.value) };
  }
  async function write(key: string, value: unknown, revision: number) {
    const id = idFor(key);
    const encrypted = cipher.seal(id, value);
    const kind = z.array(z.string()).parse(JSON.parse(key))[0];
    if (revision === 0) {
      await db("yada_records")
        .insert({ id, value: encrypted, revision: 1, kind })
        .onConflict("id")
        .ignore();
      const raw: unknown = await db("yada_records").where({ id }).first();
      if (rowSchema.parse(raw).value !== encrypted) throw new StorageConflict();
    } else {
      const updated = await db("yada_records")
        .where({ id, revision })
        .update({ value: encrypted, revision: revision + 1, kind });
      if (updated !== 1) throw new StorageConflict();
    }
    return revision + 1;
  }
  async function mutate<T>(
    key: string,
    change: (value: unknown) => { value: unknown; result: T },
  ): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const record = await read(key);
      const next = change(record?.value);
      try {
        await write(key, next.value, record?.revision ?? 0);
        return next.result;
      } catch (error) {
        if (!(error instanceof StorageConflict)) throw error;
      }
    }
    throw new StorageConflict();
  }
  async function scan(kind: string, after = "", limit = 100) {
    const rows: unknown = await db("yada_records")
      .where({ kind })
      .andWhere("id", ">", after)
      .orderBy("id")
      .limit(z.number().int().min(1).max(1000).parse(limit));
    return z
      .array(rowSchema.extend({ id: z.string() }))
      .parse(rows)
      .map((row) => ({ id: row.id, value: cipher.open(row.id, row.value) }));
  }
  async function remove(key: string) {
    await db("yada_records")
      .where({ id: idFor(key) })
      .delete();
  }
  return { read, write, mutate, scan, remove };
}
