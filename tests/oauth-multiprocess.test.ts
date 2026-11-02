import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOAuthStore } from "../src/storage/oauth.js";
import { openDatabase } from "../src/storage/database.js";
import { recordStore } from "../src/storage/records.js";
import { drivers, storageFixture } from "./helpers/storage.js";

type Outcome = { fenced: boolean; start?: number; end?: number };
function contender(config: unknown, id: string, stallMs = 0) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/oauth-contender.ts"],
    {
      env: {
        ...process.env,
        YADA_OAUTH_CONFIG: JSON.stringify(config),
        YADA_OAUTH_ID: id,
        YADA_OAUTH_STALL_MS: String(stallMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  let claimed = () => {};
  const owned = new Promise<void>((resolve) => (claimed = resolve));
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("owned\n")) claimed();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const outcome = new Promise<Outcome>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Contender failed: ${errors}`));
        return;
      }
      const done = /done (.*)\n/.exec(output);
      resolve(
        done
          ? { fenced: false, ...(JSON.parse(done[1] ?? "{}") as object) }
          : { fenced: true },
      );
    });
  });
  return { owned, outcome };
}
async function token(config: Parameters<typeof openDatabase>[0], id: string) {
  const db = await openDatabase(config);
  try {
    const session = await createOAuthStore(
      recordStore(db, config.encryptionKey),
    ).load(id);
    return Number(session?.tokens?.access_token ?? 0);
  } finally {
    await db.destroy();
  }
}
for (const driver of ["postgres", "mysql"] as const)
  describe.skipIf(!drivers.includes(driver))(
    `${driver} OAuth contention`,
    () => {
      it(`concurrent processes refresh one at a time without losing updates`, async () => {
        const { config } = await storageFixture(driver);
        const id = randomUUID();
        const outcomes = await Promise.all(
          Array.from({ length: 5 }, () => contender(config, id).outcome),
        );
        expect(outcomes.every((outcome) => !outcome.fenced)).toBe(true);
        const spans = outcomes
          .map(({ start = 0, end = 0 }) => ({ start, end }))
          .sort((a, b) => a.start - b.start);
        for (const [index, span] of spans.entries())
          if (index > 0)
            expect(span.start).toBeGreaterThanOrEqual(
              spans[index - 1]?.end ?? 0,
            );
        expect(await token(config, id)).toBe(5);
      }, 30_000);
      it(`a process stalled past lease expiry is fenced and loses no updates`, async () => {
        const { config } = await storageFixture(driver);
        const id = randomUUID();
        const stalled = contender(config, id, 1200);
        await stalled.owned;
        const outcomes = await Promise.all(
          Array.from({ length: 3 }, () => contender(config, id).outcome),
        );
        expect(await stalled.outcome).toEqual({ fenced: true });
        expect(outcomes.every((outcome) => !outcome.fenced)).toBe(true);
        expect(await token(config, id)).toBe(3);
      }, 30_000);
    },
  );
