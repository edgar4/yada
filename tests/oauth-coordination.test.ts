import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createOAuthStore } from "../src/storage/oauth.js";
import { openDatabase } from "../src/storage/database.js";
import { recordStore } from "../src/storage/records.js";
import type { McpOAuthStore, StorageConfig } from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function coordinated(store: McpOAuthStore) {
  if (!store.coordinate) throw new Error("Missing coordination");
  return store.coordinate.bind(store);
}
for (const driver of ["sqlite", "postgres", "mysql"] as const) {
  const url =
    process.env[
      driver === "postgres" ? "YADA_TEST_POSTGRES_URL" : "YADA_TEST_MYSQL_URL"
    ];
  describe.skipIf(driver !== "sqlite" && !url)(
    `${driver} OAuth coordination`,
    () => {
      async function setup(leaseMs = 30_000) {
        const directory = await mkdtemp(join(tmpdir(), "yada-oauth-"));
        cleanup.push(() => rm(directory, { recursive: true, force: true }));
        const config: StorageConfig =
          driver === "sqlite"
            ? {
                driver,
                filename: join(directory, "oauth.sqlite"),
                encryptionKey: "ab".repeat(32),
              }
            : { driver, url: url ?? "", encryptionKey: "ab".repeat(32) };
        const firstDb = await openDatabase(config);
        const secondDb = await openDatabase(config);
        cleanup.push(
          () => firstDb.destroy(),
          () => secondDb.destroy(),
        );
        const records = recordStore(firstDb, config.encryptionKey);
        const first = createOAuthStore(records, leaseMs);
        const second = createOAuthStore(
          recordStore(secondDb, config.encryptionKey),
          leaseMs,
        );
        return { first, second, id: randomUUID(), config, records };
      }
      it("serializes independent owners, renews long operations, and cancels waiters", async () => {
        const { first, second, id } = await setup(600);
        const started = gate();
        const release = gate();
        let escaped: McpOAuthStore | undefined;
        const owner = coordinated(first)(id, async (session) => {
          escaped = session;
          await session.update(id, {
            pending: { state: "state", expiresAt: Date.now() + 60000 },
          });
          started.resolve();
          await release.promise;
        });
        await started.promise;
        await delay(850);
        const visitor = vi.fn(() => Promise.resolve());
        await expect(
          coordinated(second)(id, visitor, AbortSignal.timeout(100)),
        ).rejects.toThrow();
        expect(visitor).not.toHaveBeenCalled();
        await expect(second.update(id, { pending: undefined })).rejects.toThrow(
          "coordination lost",
        );
        release.resolve();
        await owner;
        await expect(
          escaped?.update(id, { pending: undefined }),
        ).rejects.toThrow("coordination lost");
        await coordinated(second)(id, async (session) => {
          expect(await session.consumePending(id, "wrong")).toBeUndefined();
          expect((await session.consumePending(id, "state"))?.state).toBe(
            "state",
          );
        });
        expect((await first.load(id))?.pending).toBeUndefined();
      });
      it("fences expired workers and cannot release a replacement owner's lease", async () => {
        const { first, second, id } = await setup();
        const ready = gate();
        const finish = gate();
        const replacementReady = gate();
        const finishReplacement = gate();
        let stale: McpOAuthStore | undefined;
        const original = coordinated(first)(id, async (session) => {
          stale = session;
          ready.resolve();
          await finish.promise;
          await session.update(id, {
            tokens: { access_token: "stale", token_type: "Bearer" },
          });
        });
        await ready.promise;
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60000);
        const replacement = coordinated(second)(id, async (session) => {
          await session.update(id, {
            tokens: { access_token: "fresh", token_type: "Bearer" },
            pending: { state: "new", expiresAt: Date.now() + 60000 },
          });
          replacementReady.resolve();
          await finishReplacement.promise;
        });
        await replacementReady.promise;
        await expect(stale?.load(id)).rejects.toThrow("coordination lost");
        await expect(stale?.consumePending(id, "new")).rejects.toThrow(
          "coordination lost",
        );
        await expect(stale?.update("another-key", {})).rejects.toThrow(
          "coordination lost",
        );
        finish.resolve();
        await expect(original).rejects.toThrow("coordination lost");
        await expect(
          coordinated(first)(
            id,
            () => Promise.resolve(),
            AbortSignal.timeout(50),
          ),
        ).rejects.toThrow();
        finishReplacement.resolve();
        await replacement;
        clock.mockRestore();
        expect((await first.load(id))?.tokens?.access_token).toBe("fresh");
        expect((await first.load(id))?.pending?.state).toBe("new");
      });
      it("releases failed or cancelled owners and fences delayed saves", async () => {
        const { first, second, id } = await setup();
        await expect(
          coordinated(first)(id, () => Promise.reject(new Error("failure"))),
        ).rejects.toThrow("failure");
        const ready = gate();
        const finish = gate();
        const aborted = new AbortController();
        let late: Promise<void> | undefined;
        const execution = coordinated(first)(
          id,
          (session) => {
            late = finish.promise.then(() =>
              session.update(id, { pending: undefined }),
            );
            ready.resolve();
            return late;
          },
          aborted.signal,
        );
        await ready.promise;
        aborted.abort();
        await expect(execution).rejects.toThrow();
        await coordinated(second)(id, (session) =>
          session.update(id, {
            pending: { state: "new", expiresAt: Date.now() + 1000 },
          }),
        );
        finish.resolve();
        await expect(late).rejects.toThrow("coordination lost");
        expect((await first.load(id))?.pending?.state).toBe("new");
      });
      it("fences a separate process suspended past lease expiry", async () => {
        const { first, config, id } = await setup();
        const worker = spawn(
          process.execPath,
          ["--import", "tsx", "tests/fixtures/oauth-worker.ts"],
          {
            env: {
              ...process.env,
              YADA_OAUTH_CONFIG: JSON.stringify(config),
              YADA_OAUTH_ID: id,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const started = gate();
        let output = "";
        let errors = "";
        worker.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("owned\n")) started.resolve();
        });
        worker.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        const exited = new Promise<number | null>((resolve, reject) => {
          worker.on("exit", resolve);
          worker.on("error", reject);
        });
        try {
          await Promise.race([
            started.promise,
            exited.then(() => {
              throw new Error(`Worker exited before claim: ${errors}`);
            }),
            delay(5000).then(() => {
              throw new Error("Worker claim timeout");
            }),
          ]);
          await delay(500);
          await coordinated(first)(id, (session) =>
            session.update(id, {
              tokens: { access_token: "replacement", token_type: "Bearer" },
            }),
          );
          expect(await exited).toBe(0);
          expect(output).toContain("fenced\n");
          expect((await first.load(id))?.tokens?.access_token).toBe(
            "replacement",
          );
        } finally {
          worker.kill("SIGKILL");
          await exited;
        }
      });
      it("aborts after lease renewal fails and redacts acquisition failures", async () => {
        const { first, second, id, records } = await setup(600);
        const fault = vi
          .spyOn(records, "mutate")
          .mockRejectedValue(new Error("private-database-secret"));
        await expect(
          coordinated(first)(id, () => Promise.resolve()),
        ).rejects.toThrow("OAuth coordination unavailable");
        fault.mockRestore();
        const ready = gate();
        const finish = gate();
        let late: McpOAuthStore | undefined;
        const owner = coordinated(first)(id, (session) => {
          late = session;
          ready.resolve();
          return finish.promise;
        });
        await ready.promise;
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
        await expect(owner).rejects.toThrow();
        clock.mockRestore();
        await expect(late?.update(id, {})).rejects.toThrow("coordination lost");
        finish.resolve();
        await coordinated(second)(id, (session) =>
          session.update(id, {
            tokens: { access_token: "fresh", token_type: "Bearer" },
          }),
        );
        expect((await first.load(id))?.tokens?.access_token).toBe("fresh");
      });
    },
  );
}
