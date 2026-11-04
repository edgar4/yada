import { describe, expect, it } from "vitest";
import { drivers, storageFixture } from "./helpers/storage.js";
import { openDatabase } from "../src/storage/database.js";
import { recordStore, StorageConflict } from "../src/storage/records.js";
import { createRetention } from "../src/storage/retention.js";

describe.each(drivers)("%s eraseActor", (driver) => {
  it("erases conversations, memory and OAuth, and reports what remains", async () => {
    const s = await storageFixture(driver);
    const other = {
      ...s.identity,
      actorId: "other" as typeof s.identity.actorId,
    };
    const key = (actorId: string) =>
      JSON.stringify([s.identity.tenantId, actorId, "server", "redirect"]);
    const tokens = { access_token: "a", token_type: "Bearer" };
    const submit = (identity: typeof s.identity, conversation: string) =>
      s.storage.jobs.submit(identity, conversation, {
        id: "run",
        input: "Hi",
        profileId: "p",
      });
    await submit(s.identity, "busy");
    await submit(s.identity, "done");
    await s.storage.jobs.update(
      s.identity,
      "done",
      "run",
      { type: "completed", text: "ok" },
      { status: "completed", text: "ok" },
    );
    await submit(other, "theirs");
    await s.storage.oauth.update(key(s.identity.actorId), { tokens });
    await s.storage.oauth.update(key("other"), { tokens });
    await s.storage.memory.put(s.identity, { key: "k", text: "mine" });
    await s.storage.memory.put(other, { key: "k", text: "theirs" });

    expect(await s.storage.retention.eraseActor(s.identity)).toEqual({
      remaining: ["busy"],
    });
    expect(
      (await s.storage.conversations.inspect(s.identity, "done")).erased,
    ).toBe(true);
    expect(
      (await s.storage.conversations.inspect(s.identity, "busy")).erased,
    ).toBe(false);
    expect(await s.storage.oauth.load(key(s.identity.actorId))).toBeUndefined();
    expect(await s.storage.memory.list(s.identity)).toEqual([]);
    expect(await s.storage.memory.list(other)).toHaveLength(1);
    expect((await s.storage.oauth.load(key("other")))?.tokens).toEqual(tokens);
    expect(
      (await s.storage.conversations.inspect(other, "theirs")).exists,
    ).toBe(true);

    await s.storage.jobs.update(
      s.identity,
      "busy",
      "run",
      { type: "cancelled" },
      { status: "cancelled" },
    );
    expect(await s.storage.retention.eraseActor(s.identity)).toEqual({
      remaining: [],
    });
    expect(
      (await s.storage.conversations.inspect(s.identity, "busy")).erased,
    ).toBe(true);
    expect(await s.storage.retention.eraseActor(s.identity)).toEqual({
      remaining: [],
    });
  });

  it("reports a conversation that changes during erasure and still erases the rest", async () => {
    const s = await storageFixture(driver);
    const key = JSON.stringify([
      s.identity.tenantId,
      s.identity.actorId,
      "s",
      "r",
    ]);
    await s.storage.oauth.update(key, {
      tokens: { access_token: "a", token_type: "Bearer" },
    });
    await s.storage.memory.put(s.identity, { key: "k", text: "mine" });
    for (const id of ["racing", "plain"]) {
      await s.storage.jobs.submit(s.identity, id, {
        id: "run",
        input: "Hi",
        profileId: "p",
      });
      await s.storage.jobs.update(
        s.identity,
        id,
        "run",
        { type: "completed", text: "ok" },
        { status: "completed", text: "ok" },
      );
    }
    const db = await openDatabase(s.config);
    try {
      const records = recordStore(db, s.config.encryptionKey);
      const retention = createRetention({
        ...records,
        write: (...args: Parameters<typeof records.write>) =>
          args[0].includes("racing")
            ? Promise.reject(new StorageConflict())
            : records.write(...args),
      });
      expect(await retention.eraseActor(s.identity)).toEqual({
        remaining: ["racing"],
      });
      expect(
        (await s.storage.conversations.inspect(s.identity, "plain")).erased,
      ).toBe(true);
      expect(await s.storage.memory.list(s.identity)).toEqual([]);
      expect(await s.storage.oauth.load(key)).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  it("erases the actor's pending connect state and no one else's", async () => {
    const s = await storageFixture(driver);
    const pending = (actorId: string) => ({
      pending: {
        state: JSON.stringify({
          tenantId: s.identity.tenantId,
          actorId,
        }),
        expiresAt: Date.now() + 60_000,
      },
    });
    const mine = JSON.stringify(["connect-state", "mine"]);
    const other = JSON.stringify(["connect-state", "other"]);
    await s.storage.oauth.update(mine, pending(s.identity.actorId));
    await s.storage.oauth.update(other, pending(`${s.identity.actorId}2`));
    await s.storage.retention.eraseActor(s.identity);
    expect(await s.storage.oauth.load(mine)).toBeUndefined();
    expect(await s.storage.oauth.load(other)).toBeDefined();
  });
  it("still erases memory and OAuth when a conversation fails", async () => {
    const s = await storageFixture(driver);
    await s.storage.memory.put(s.identity, { key: "k", text: "mine" });
    await s.storage.jobs.submit(s.identity, "broken", {
      id: "run",
      input: "Hi",
      profileId: "p",
    });
    await s.storage.jobs.update(
      s.identity,
      "broken",
      "run",
      { type: "completed", text: "ok" },
      { status: "completed", text: "ok" },
    );
    const db = await openDatabase(s.config);
    try {
      const records = recordStore(db, s.config.encryptionKey);
      const retention = createRetention({
        ...records,
        write: () => Promise.reject(new Error("offline")),
      });
      await expect(retention.eraseActor(s.identity)).rejects.toThrow("offline");
      expect(await s.storage.memory.list(s.identity)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it("pages past 100 conversations", async () => {
    const s = await storageFixture(driver);
    for (let n = 0; n < 105; n++) {
      await s.storage.jobs.submit(s.identity, `c${String(n)}`, {
        id: "run",
        input: "Hi",
        profileId: "p",
      });
    }
    const { remaining } = await s.storage.retention.eraseActor(s.identity);
    expect(remaining).toHaveLength(105);
    expect(new Set(remaining).size).toBe(105);
  });
});
