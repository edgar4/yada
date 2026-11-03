import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { drivers, storageFixture } from "./helpers/storage.js";
import * as entry from "../src/entries/storage.js";
import { backfillRecords, openDatabase } from "../src/storage/database.js";
import { conversationKey } from "../src/storage/conversations.js";
import { storageCipher } from "../src/storage/crypto.js";
import { recordStore } from "../src/storage/records.js";

const input = (id: string) => ({ id, profileId: "v1", input: `Hi ${id}` });
const idOf = (key: string) => createHash("sha256").update(key).digest("hex");

it("exports streamBackup from the storage entry", () => {
  expect(typeof entry.streamBackup).toBe("function");
});

for (const driver of drivers)
  describe(`${driver} service review fixes`, () => {
    it("skips corrupt conversation rows when scheduling", async () => {
      const s = await storageFixture(driver);
      await s.storage.jobs.submit(s.identity, "good", input("one"));
      const db = await openDatabase(s.config);
      try {
        await recordStore(db, s.config.encryptionKey).write(
          conversationKey(s.identity, "bad"),
          { identity: s.identity, id: "bad", jobs: "nope" },
          0,
          true,
        );
      } finally {
        await db.destroy();
      }
      const onCorrupt = vi.fn();
      const page = await s.storage.jobs.pending("", onCorrupt);
      expect(page.jobs.map((entry) => entry.conversationId)).toEqual(["good"]);
      expect(onCorrupt).toHaveBeenCalledOnce();
    });

    it("drops pre-upgrade grants and erases scoped grants with the conversation", async () => {
      const s = await storageFixture(driver);
      const legacyKey = JSON.stringify([
        "grant",
        "t",
        "a",
        "conversation",
        "chat",
        "x",
        "1",
        "h",
      ]);
      const db = await openDatabase(s.config);
      try {
        const cipher = storageCipher(s.config.encryptionKey);
        await db("yada_records").insert({
          id: idOf(legacyKey),
          value: cipher.seal(idOf(legacyKey), true),
          revision: 1,
          kind: null,
        });
        await backfillRecords(db, s.config);
        expect(await db("yada_records").where({ id: idOf(legacyKey) })).toEqual(
          [],
        );
      } finally {
        await db.destroy();
      }
      const action = {
        id: "a1",
        runId: JSON.stringify(["chat", "run"]),
        callId: "c",
        tool: "rename",
        toolVersion: "1",
        args: { name: "Ada" },
        preview: "p",
        version: "1",
        expiresAt: Date.now() + 60_000,
        status: "approved" as const,
      };
      await s.storage.actions.remember(s.identity, action, "run");
      await s.storage.actions.remember(s.identity, action, "conversation");
      await s.storage.actions.remember(
        s.identity,
        { ...action, runId: JSON.stringify(["other", "run"]) },
        "run",
      );
      await s.storage.retention.eraseConversation(s.identity, "chat");
      const remembered = (runId: string) =>
        s.storage.actions.remembered(s.identity, runId, "rename", "1", {
          name: "Ada",
        });
      expect(await remembered(action.runId)).toBe(false);
      expect(await remembered(JSON.stringify(["other", "run"]))).toBe(true);
    });
  });
