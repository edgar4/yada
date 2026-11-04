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
export function isRetryable(error: unknown) {
  if (error instanceof StorageConflict) return true;
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  return (
    code === "40001" ||
    code === "40P01" ||
    errno === 1213 ||
    errno === 1205 ||
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT"
  );
}
export const conversationOf = (runId: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runId);
  } catch {
    return runId;
  }
  return Array.isArray(parsed) && typeof parsed[0] === "string"
    ? parsed[0]
    : runId;
};
const oauthOwner = (id: string) => {
  try {
    const parsed: unknown = JSON.parse(id);
    return Array.isArray(parsed) ? parsed.slice(0, 2) : undefined;
  } catch {
    return undefined;
  }
};
export function scopeFor(key: string) {
  const [kind, ...parts] = z.array(z.string()).parse(JSON.parse(key));
  const length = { conversation: 2, retired: 3 }[kind ?? ""];
  const owner =
    kind === "oauth"
      ? oauthOwner(parts[0] ?? "")
      : kind === "grant"
        ? [
            parts[0],
            parts[1],
            parts[2] === "run" ? conversationOf(parts[3] ?? "") : parts[3],
          ]
        : length === undefined
          ? undefined
          : parts.slice(0, length);
  return (
    owner && createHash("sha256").update(JSON.stringify(owner)).digest("hex")
  );
}
export function recordStore(
  db: Knex,
  encryptionKey: string,
  previousKeys: readonly string[] = [],
) {
  const cipher = storageCipher(encryptionKey, previousKeys);
  const idFor = (key: string) => createHash("sha256").update(key).digest("hex");
  async function read(key: string) {
    const id = idFor(key);
    const raw: unknown = await db("yada_records").where({ id }).first();
    if (!raw) return undefined;
    const row = rowSchema.parse(raw);
    return { revision: row.revision, value: cipher.open(id, row.value) };
  }
  async function write(
    key: string,
    value: unknown,
    revision: number,
    active?: boolean,
  ) {
    const id = idFor(key);
    const encrypted = cipher.seal(id, value);
    const kind = z.array(z.string()).parse(JSON.parse(key))[0];
    const scope = scopeFor(key);
    if (revision === 0) {
      await db.transaction(async (tx) => {
        await tx("yada_records")
          .insert({
            id,
            value: encrypted,
            revision: 1,
            kind,
            scope,
            updated_at: Date.now(),
            active: active ?? false,
          })
          .onConflict("id")
          .ignore();
        const raw: unknown = await tx("yada_records").where({ id }).first();
        if (rowSchema.safeParse(raw).data?.value !== encrypted)
          throw new StorageConflict();
      });
    } else {
      const updated = await db("yada_records")
        .where({ id, revision })
        .update({
          value: encrypted,
          revision: revision + 1,
          kind,
          scope,
          updated_at: Date.now(),
          ...(active === undefined ? {} : { active }),
        });
      if (updated !== 1) throw new StorageConflict();
    }
    return revision + 1;
  }
  async function mutate<T>(
    key: string,
    change: (value: unknown) => {
      value: unknown;
      result: T;
      active?: boolean;
    },
  ): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const record = await read(key);
      const next = change(record?.value);
      try {
        await write(key, next.value, record?.revision ?? 0, next.active);
        return next.result;
      } catch (error) {
        if (!isRetryable(error)) throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 2 ** Math.min(attempt, 6)),
      );
    }
    throw new StorageConflict();
  }
  async function scan(
    kind: string,
    after = "",
    limit = 100,
    active?: boolean,
    scopeKey?: string,
  ) {
    const rows: unknown = await db("yada_records")
      .where({
        kind,
        ...(active === undefined ? {} : { active }),
        ...(scopeKey === undefined ? {} : { scope: scopeFor(scopeKey) }),
      })
      .andWhere("id", ">", after)
      .orderBy("id")
      .limit(z.number().int().min(1).max(1000).parse(limit));
    return z
      .array(rowSchema.extend({ id: z.string() }))
      .parse(rows)
      .map((row) => ({
        id: row.id,
        revision: row.revision,
        value: cipher.open(row.id, row.value),
      }));
  }
  async function recent(
    kind: string,
    scopeKey: string,
    after?: { at: number; id: string },
    limit = 100,
  ) {
    const rows: unknown = await db("yada_records")
      .where({ kind, scope: scopeFor(scopeKey) })
      .andWhere((query) => {
        if (after)
          void query.where("updated_at", "<", after.at).orWhere((same) => {
            void same
              .where("updated_at", after.at)
              .andWhere("id", ">", after.id);
          });
      })
      .orderBy([
        { column: "updated_at", order: "desc" },
        { column: "id", order: "asc" },
      ])
      .limit(z.number().int().min(1).max(1000).parse(limit));
    return z
      .array(
        rowSchema.extend({ id: z.string(), updated_at: z.coerce.number() }),
      )
      .parse(rows)
      .map((row) => ({
        id: row.id,
        at: row.updated_at,
        value: cipher.open(row.id, row.value),
      }));
  }
  async function remove(key: string) {
    await db("yada_records")
      .where({ id: idFor(key) })
      .delete();
  }
  async function removeRow(id: string, revision: number) {
    return (await db("yada_records").where({ id, revision }).delete()) > 0;
  }
  async function removeScope(kind: string, scopeKey: string) {
    await db("yada_records")
      .where({ kind, scope: scopeFor(scopeKey) })
      .delete();
  }
  function transaction<T>(
    operation: (records: ReturnType<typeof recordStore>) => Promise<T>,
  ): Promise<T> {
    return db.transaction((tx) =>
      operation(recordStore(tx, encryptionKey, previousKeys)),
    );
  }
  async function transact<T>(
    operation: (records: ReturnType<typeof recordStore>) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await transaction(operation);
      } catch (error) {
        if (!isRetryable(error)) throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 2 ** Math.min(attempt, 6)),
      );
    }
    throw new StorageConflict();
  }
  return {
    read,
    write,
    mutate,
    scan,
    recent,
    remove,
    removeRow,
    removeScope,
    transaction,
    transact,
  };
}
