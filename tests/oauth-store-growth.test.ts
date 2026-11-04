import { describe, expect, it } from "vitest";
import { createMcpOAuth } from "../src/index.js";
import { drivers, storageFixture } from "./helpers/storage.js";

const key = (actor: string, server = "s") =>
  JSON.stringify(["t", actor, server, "r"]);

describe.each(drivers)("%s OAuth record growth", (driver) => {
  it("does not write for an unknown state", async () => {
    const s = await storageFixture(driver);
    expect(
      await s.storage.oauth.consumePending(key("nobody"), "guess"),
    ).toBeUndefined();
    expect(await s.storage.oauth.load(key("nobody"))).toBeUndefined();
  });

  it("still consumes a known state once and ignores a wrong one", async () => {
    const s = await storageFixture(driver);
    const pending = { state: "good", expiresAt: Date.now() + 1000 };
    await s.storage.oauth.update(key("a"), { pending });
    expect(
      await s.storage.oauth.consumePending(key("a"), "bad"),
    ).toBeUndefined();
    expect(await s.storage.oauth.consumePending(key("a"), "good")).toEqual(
      pending,
    );
    expect(
      await s.storage.oauth.consumePending(key("a"), "good"),
    ).toBeUndefined();
  });

  it("rejects an unknown callback before creating a record", async () => {
    const s = await storageFixture(driver);
    const oauth = createMcpOAuth({
      serverUrl: "https://mcp.example/mcp",
      redirectUrl: "https://app.example/callback",
      identity: { tenantId: "t", actorId: "stranger" },
      store: s.storage.oauth,
      redirect: () => Promise.resolve(),
    });
    await expect(
      oauth.complete(new URLSearchParams({ state: "guess", code: "c" })),
    ).rejects.toThrow("Invalid or expired OAuth state");
    expect(await s.storage.oauth.prune()).toBe(0);
  });

  it("prunes only records that hold nothing useful", async () => {
    const s = await storageFixture(driver);
    const { oauth } = s.storage;
    const tokens = { access_token: "a", token_type: "Bearer" };
    await oauth.update(key("tokens"), { tokens });
    await oauth.update(key("client"), { client: { client_id: "c" } });
    await oauth.update(key("live"), {
      pending: { state: "s", expiresAt: Date.now() + 60_000 },
    });
    await oauth.update(key("stale"), {
      pending: { state: "s", expiresAt: Date.now() - 1 },
    });
    await oauth.update(key("empty"), {});
    expect(await oauth.prune()).toBe(2);
    expect(await oauth.load(key("stale"))).toBeUndefined();
    expect(await oauth.load(key("empty"))).toBeUndefined();
    expect((await oauth.load(key("tokens")))?.tokens).toEqual(tokens);
    expect((await oauth.load(key("client")))?.client).toBeDefined();
    expect((await oauth.load(key("live")))?.pending).toBeDefined();
  });

  it("erases every record of one actor only", async () => {
    const s = await storageFixture(driver);
    const { oauth } = s.storage;
    const tokens = { access_token: "a", token_type: "Bearer" };
    await oauth.update(key("a", "one"), { tokens });
    await oauth.update(key("a", "two"), { tokens });
    await oauth.update(key("b", "one"), { tokens });
    await oauth.eraseActor({ tenantId: "t", actorId: "a" });
    expect(await oauth.load(key("a", "one"))).toBeUndefined();
    expect(await oauth.load(key("a", "two"))).toBeUndefined();
    expect((await oauth.load(key("b", "one")))?.tokens).toEqual(tokens);
  });

  it("forgets a whole record, client registration included", async () => {
    const s = await storageFixture(driver);
    const oauth = createMcpOAuth({
      serverUrl: "https://mcp.example/mcp",
      redirectUrl: "https://app.example/callback",
      identity: { tenantId: "t", actorId: "a" },
      store: s.storage.oauth,
      redirect: () => Promise.resolve(),
    });
    await oauth.provider.saveClientInformation?.({ client_id: "c" });
    await oauth.forget();
    expect(
      await s.storage.oauth.load(
        JSON.stringify([
          "t",
          "a",
          "https://mcp.example/mcp",
          "https://app.example/callback",
        ]),
      ),
    ).toBeUndefined();
  });
});
