import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { openDatabase } from "../../src/storage/database.js";
import { recordStore } from "../../src/storage/records.js";
import { storageConfig } from "../../src/storage/config.js";
import { createOAuthStore } from "../../src/storage/oauth.js";
const config = storageConfig.parse(
  JSON.parse(process.env["YADA_OAUTH_CONFIG"] ?? "{}"),
);
const id = z.string().parse(process.env["YADA_OAUTH_ID"]);
const stall = Number(process.env["YADA_OAUTH_STALL_MS"] ?? 0);
const db = await openDatabase(config);
const store = createOAuthStore(recordStore(db, config.encryptionKey), 300);
try {
  await store.coordinate?.(id, async (session) => {
    const start = Date.now();
    process.stdout.write("owned\n");
    const current = await session.load(id);
    const next = Number(current?.tokens?.access_token ?? 0) + 1;
    if (stall)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stall);
    else await delay(150);
    await session.update(id, {
      tokens: { access_token: String(next), token_type: "Bearer" },
    });
    process.stdout.write(
      `done ${JSON.stringify({ start, end: Date.now() })}\n`,
    );
  });
} catch {
  process.stdout.write("fenced\n");
} finally {
  await db.destroy();
}
