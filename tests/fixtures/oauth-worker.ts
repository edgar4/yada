import { z } from "zod";
import { openDatabase } from "../../src/storage/database.js";
import { recordStore } from "../../src/storage/records.js";
import { storageConfig } from "../../src/storage/config.js";
import { createOAuthStore } from "../../src/storage/oauth.js";
const config = storageConfig.parse(
  JSON.parse(process.env["YADA_OAUTH_CONFIG"] ?? "{}"),
);
const id = z.string().parse(process.env["YADA_OAUTH_ID"]);
const db = await openDatabase(config);
const store = createOAuthStore(recordStore(db, config.encryptionKey), 300);
try {
  await store.coordinate?.(id, async (session) => {
    process.stdout.write("owned\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600);
    await session.update(id, {
      tokens: { access_token: "stale", token_type: "Bearer" },
    });
  });
  process.exitCode = 1;
} catch {
  process.stdout.write("fenced\n");
} finally {
  await db.destroy();
}
