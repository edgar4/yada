import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createStorage,
  createFakeProvider,
  readTool,
  runDurable,
  RunLeaseError,
  CheckpointError,
  type StorageConfig,
  type DurableRequest,
} from "../src/index.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const identity = { actorId: "actor", tenantId: "tenant" };
const request: DurableRequest = {
  input: "Find a",
  system: "Help",
  profileId: "test-v1",
  provider: "fake",
  tools: [],
  maxRounds: 8,
  maxToolCalls: 16,
};
const drivers = [
  "sqlite",
  ...(process.env["YADA_TEST_POSTGRES_URL"] ? (["postgres"] as const) : []),
  ...(process.env["YADA_TEST_MYSQL_URL"] ? (["mysql"] as const) : []),
] as const;
for (const driver of drivers)
  describe(`${driver} durable recovery`, () => {
    async function setup() {
      const dir = await mkdtemp(join(tmpdir(), "yada-recovery-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const config: StorageConfig =
        driver === "sqlite"
          ? {
              driver,
              filename: join(dir, "runs.sqlite"),
              encryptionKey: "ab".repeat(32),
            }
          : {
              driver,
              url:
                process.env[
                  driver === "postgres"
                    ? "YADA_TEST_POSTGRES_URL"
                    : "YADA_TEST_MYSQL_URL"
                ] ?? "",
              encryptionKey: "ab".repeat(32),
            };
      const store = await createStorage(config);
      cleanups.push(() => store.close());
      return { store, config, id: randomUUID() };
    }
    it("recovers after SIGKILL without repeating a committed read", async () => {
      const s = await setup();
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/crash-run.ts"],
        {
          env: {
            ...process.env,
            YADA_CRASH_CONFIG: JSON.stringify(s.config),
            YADA_CRASH_ID: s.id,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<void>((resolve) =>
        child.once("close", () => {
          resolve();
        }),
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Child readiness timeout"));
          }, 8000);
          child.stdout.once("data", () => {
            clearTimeout(timeout);
            resolve();
          });
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`Child exited ${String(code)}: ${stderr}`));
          });
        });
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      await delay(1100);
      const execute = vi.fn(() => Promise.resolve("should not repeat"));
      const tool = readTool({
        name: "lookup",
        description: "Lookup",
        input: z.strictObject({ id: z.string() }),
        authorize: () => Promise.resolve(true),
        execute,
      });
      const provider = createFakeProvider((req) => {
        expect(req.messages.at(-1)).toMatchObject({
          role: "tool",
          content: "persisted result",
        });
        return { content: "Recovered", toolCalls: [], finishReason: "stop" };
      });
      const options = {
        runId: s.id,
        profileId: "test-v1",
        store: s.store.runs,
        leaseMs: 1000,
        identity,
        provider,
        tools: [tool],
        input: "Find a",
        system: "Help",
        signal: AbortSignal.timeout(3000),
      };
      expect(await runDurable(options)).toEqual({
        status: "completed",
        text: "Recovered",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(await runDurable(options)).toEqual({
        status: "completed",
        text: "Recovered",
      });
      expect(provider.requests).toHaveLength(1);
    }, 15000);
    it("fences stale workers and allows only one claimant", async () => {
      const s = await setup();
      const results = await Promise.allSettled([
        s.store.runs.claim(identity, s.id, request, 100),
        s.store.runs.claim(identity, s.id, request, 100),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const first = await s.store.runs.load(identity, s.id);
      await delay(120);
      const next = await s.store.runs.claim(identity, s.id, request, 1000);
      expect(next.lease?.token).not.toBe(first?.lease?.token);
      await expect(
        s.store.runs.renew(identity, s.id, first?.lease?.token ?? "", 1000),
      ).rejects.toBeInstanceOf(RunLeaseError);
      await expect(
        s.store.runs.save(
          identity,
          s.id,
          first?.lease?.token ?? "",
          { version: 1, messages: [], pending: [], rounds: 0, calls: 0 },
          1000,
        ),
      ).rejects.toBeInstanceOf(RunLeaseError);
      expect(
        await s.store.runs.load({ ...identity, tenantId: "other" }, s.id),
      ).toBeUndefined();
    });
    it("rejects changed run configuration", async () => {
      const s = await setup();
      await s.store.runs.claim(identity, s.id, request, 100);
      await expect(
        s.store.runs.claim(
          identity,
          s.id,
          { ...request, profileId: "changed" },
          100,
        ),
      ).rejects.toThrow("configuration mismatch");
    });
    it("resumes a saved decision after the worker loses its response", async () => {
      const s = await setup();
      const execute = vi.fn(() => Promise.resolve("Found"));
      const tool = readTool({
        name: "lookup",
        description: "Lookup",
        input: z.strictObject({}),
        authorize: () => Promise.resolve(true),
        execute,
      });
      const provider = createFakeProvider((_req, call) =>
        call === 1
          ? {
              content: "",
              toolCalls: [{ id: "1", name: "lookup", args: {} }],
              finishReason: "tool_calls",
            }
          : { content: "Done", toolCalls: [], finishReason: "stop" },
      );
      const options = {
        runId: s.id,
        profileId: "v1",
        store: s.store.runs,
        leaseMs: 1000,
        identity,
        provider,
        tools: [tool],
        input: "Lookup",
        system: "Help",
        signal: AbortSignal.timeout(10000),
      };
      await expect(
        runDurable({
          ...options,
          store: {
            ...s.store.runs,
            save: async (...args) => {
              await s.store.runs.save(...args);
              if (args[3].pending.length)
                throw new Error("Worker disconnected");
            },
          },
        }),
      ).rejects.toBeInstanceOf(CheckpointError);
      expect(execute).not.toHaveBeenCalled();
      await delay(1100);
      expect(await runDurable(options)).toEqual({
        status: "completed",
        text: "Done",
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(provider.requests).toHaveLength(2);
    });
    it("aborts execution when lease renewal fails without saving a terminal result", async () => {
      const s = await setup();
      const renew = vi.fn(() => Promise.reject(new RunLeaseError()));
      await expect(
        runDurable({
          runId: s.id,
          profileId: "v1",
          store: { ...s.store.runs, renew },
          leaseMs: 100,
          identity,
          provider: createFakeProvider(() => new Promise<never>(() => {})),
          tools: [],
          input: "Hi",
          system: "Help",
          signal: AbortSignal.timeout(3000),
        }),
      ).rejects.toBeInstanceOf(CheckpointError);
      expect(renew).toHaveBeenCalledOnce();
      const state = await s.store.runs.load(identity, s.id);
      expect(state?.checkpoint?.rounds).toBe(1);
      expect(state?.checkpoint?.outcome).toBeUndefined();
    });
    it("renews a lease during slow model calls", async () => {
      const s = await setup();
      const leaseMs = 1500;
      let originalExpiry = 0;
      let token = "";
      let confirmRenewal = () => {};
      const renewed = new Promise<void>((resolve) => {
        confirmRenewal = resolve;
      });
      const renew = vi.fn(
        async (...args: Parameters<typeof s.store.runs.renew>) => {
          await s.store.runs.renew(...args);
          if (originalExpiry && Date.now() > originalExpiry) confirmRenewal();
        },
      );
      const provider = createFakeProvider(async () => {
        const initial = await s.store.runs.load(identity, s.id);
        if (!initial?.lease) throw new Error("Missing initial lease");
        originalExpiry = initial.lease.expiresAt;
        token = initial.lease.token;
        await renewed;
        const current = await s.store.runs.load(identity, s.id);
        expect(current?.lease?.token).toBe(token);
        expect(current?.lease?.expiresAt).toBeGreaterThan(originalExpiry);
        expect(current?.lease?.expiresAt).toBeGreaterThan(Date.now());
        await expect(
          s.store.runs.claim(identity, s.id, initial.request, leaseMs),
        ).rejects.toBeInstanceOf(RunLeaseError);
        return { content: "Done", toolCalls: [], finishReason: "stop" };
      });
      expect(
        await runDurable({
          runId: s.id,
          profileId: "test-v1",
          store: { ...s.store.runs, renew },
          leaseMs,
          identity,
          provider,
          tools: [],
          input: "Hi",
          system: "Help",
          signal: AbortSignal.timeout(4000),
        }),
      ).toEqual({ status: "completed", text: "Done" });
      expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(provider.requests).toHaveLength(1);
      expect((await s.store.runs.load(identity, s.id))?.lease?.token).toBe(
        token,
      );
    });
  });
