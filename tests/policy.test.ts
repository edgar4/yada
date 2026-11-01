import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { drivers, storageFixture } from "./helpers/storage.js";
import { writeTool } from "../src/core/action.js";
import { applyToolPolicy, confirmTool } from "../src/core/policy.js";
import { readTool } from "../src/core/tool.js";
import { actionExecutor } from "../src/service/actions.js";
import { createHandler } from "../src/service/http.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { operationId, unknownOutcome } from "../src/storage/actions.js";
import type { Identity, Tool } from "../src/core/contracts.js";
const readFixture = (
  name: string,
  execute = vi.fn(() => Promise.resolve("ok")),
) =>
  readTool({
    name,
    description: name,
    input: z.object({ q: z.string() }),
    authorize: () => Promise.resolve(true),
    execute,
  });
const call = { id: "call", name: "lookup", args: { q: "x" } };
const signal = () => AbortSignal.timeout(3000);
it("applies policies by exact name, glob and specificity", () => {
  const write = writeTool({
    name: "a__w",
    description: "w",
    version: "1",
    input: z.object({}),
    authorize: () => Promise.resolve(true),
    prepare: () => Promise.resolve({ preview: "p", version: "1" }),
    execute: () => Promise.resolve(""),
  });
  const tools: Tool[] = [
    readFixture("a__x"),
    readFixture("a__y"),
    readFixture("b"),
    readFixture("c.d"),
    write,
  ];
  const result = applyToolPolicy(tools, {
    "a__*": "ask",
    a__y: "deny",
    "c.d": "deny",
  });
  expect(result.map((tool) => [tool.spec.name, tool.effect])).toEqual([
    ["a__x", "write"],
    ["b", "read"],
    ["a__w", "write"],
  ]);
  expect(result[2]).toBe(write);
  expect(result[1]).toBe(tools[2]);
});
it("builds versioned previews for confirmed read tools", async () => {
  const tool = confirmTool(readFixture("lookup"), {
    preview: (args) => `Look up ${JSON.stringify(args)}`,
  });
  expect(tool.version).toMatch(/^lookup:[0-9a-f]{8}$/);
  expect(tool.version).not.toBe(
    confirmTool(
      readTool({
        name: "lookup",
        description: "x",
        input: z.object({ other: z.string() }),
        authorize: () => Promise.resolve(true),
        execute: () => Promise.resolve(""),
      }),
    ).version,
  );
  expect(
    await tool.prepare({ q: "x" }, { actorId: "a", tenantId: "t" }, signal()),
  ).toMatchObject({ preview: 'Look up {"q":"x"}' });
  expect("reconcile" in tool).toBe(false);
});
for (const driver of drivers)
  describe(`${driver} tool policy`, () => {
    async function workerFlow(decision: "approve" | "decline" | "expire") {
      const s = await storageFixture(driver);
      const execute = vi.fn(() => Promise.resolve("looked up"));
      const provider = createFakeProvider((_req, n) =>
        n === 1
          ? { content: "", toolCalls: [call], finishReason: "tool_calls" }
          : { content: "Done", toolCalls: [], finishReason: "stop" },
      );
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "run",
        input: "Go",
        profileId: "v1",
      });
      const worker = createWorker({
        storage: s.storage,
        profiles: {
          v1: {
            provider,
            tools: applyToolPolicy([readFixture("lookup", execute)], {
              "look*": "ask",
            }),
            system: "Help",
            ...(decision === "expire" ? { approvalTtlMs: 300 } : {}),
          },
        },
      });
      await worker.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "run"))?.status,
      ).toBe("awaiting_approval");
      await worker.tick();
      const id = operationId(
        s.identity,
        JSON.stringify(["chat", "run"]),
        call.id,
      );
      if (decision === "expire") await new Promise((r) => setTimeout(r, 350));
      else
        await s.storage.actions.decide(s.identity, id, decision === "approve");
      await s.storage.jobs.update(s.identity, "chat", "run", {
        type: "queued",
      });
      await worker.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "run"))?.status,
      ).toBe("completed");
      return { execute, provider, s, id };
    }
    it("runs a confirmed read tool only after approval", async () => {
      const { execute, provider } = await workerFlow("approve");
      expect(execute).toHaveBeenCalledOnce();
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
        "looked up",
      );
    });
    it("does not run a declined or expired confirmed read tool", async () => {
      for (const decision of ["decline", "expire"] as const) {
        const { execute, s, id } = await workerFlow(decision);
        expect(execute).not.toHaveBeenCalled();
        expect((await s.storage.actions.load(s.identity, id))?.status).toBe(
          decision === "decline" ? "declined" : "expired",
        );
      }
    });
    it("marks an uncertain tool without reconcile as unknown and never retries it", async () => {
      const s = await storageFixture(driver);
      const execute = vi.fn(() => Promise.reject(new Error("lost")));
      const tool = confirmTool(readFixture("lookup", execute));
      const invoke = actionExecutor(s.storage.actions, s.identity, "run");
      const id = operationId(s.identity, "run", call.id);
      await invoke(tool, call, signal());
      await s.storage.actions.decide(s.identity, id, true);
      expect(await invoke(tool, call, signal())).toBe(unknownOutcome);
      expect(await invoke(tool, call, signal())).toBe(unknownOutcome);
      expect(execute).toHaveBeenCalledOnce();
      expect((await s.storage.actions.load(s.identity, id))?.status).toBe(
        "unknown",
      );
    });
    it("marks an interrupted execution without reconcile as unknown after recovery", async () => {
      const s = await storageFixture(driver);
      const execute = vi.fn(() => Promise.resolve("ok"));
      const tool = confirmTool(readFixture("lookup", execute));
      const invoke = actionExecutor(s.storage.actions, s.identity, "run");
      const id = operationId(s.identity, "run", call.id);
      await invoke(tool, call, signal());
      await s.storage.actions.decide(s.identity, id, true);
      await s.storage.actions.begin(s.identity, id);
      expect(await invoke(tool, call, signal())).toBe(unknownOutcome);
      expect(execute).not.toHaveBeenCalled();
    });
    it("scopes remembered approvals to identity, run and conversation", async () => {
      const s = await storageFixture(driver);
      const handler = createHandler({
        storage: s.storage,
        origins: [],
        authenticate: () => Promise.resolve(s.identity),
        authorizeProfile: () => Promise.resolve(true),
      });
      const decide = (body: unknown) =>
        handler(
          new Request(
            "http://localhost/v1/conversations/chat/runs/a/approvals/" +
              operationId(s.identity, JSON.stringify(["chat", "a"]), "c1") +
              "/decision",
            { method: "POST", body: JSON.stringify(body) },
          ),
        );
      const execute = vi.fn(() => Promise.resolve("ran"));
      const tool = confirmTool(readFixture("lookup", execute));
      const executor = (identity: Identity, run: string) =>
        actionExecutor(
          s.storage.actions,
          identity,
          JSON.stringify(run.split("/")),
        );
      await s.storage.jobs.submit(s.identity, "chat", {
        id: "a",
        input: "Hi",
        profileId: "v1",
      });
      const first = executor(s.identity, "chat/a");
      await first(tool, { ...call, id: "c1" }, signal());
      await s.storage.jobs.update(s.identity, "chat", "a", {
        type: "awaiting_approval",
        approvalId: operationId(
          s.identity,
          JSON.stringify(["chat", "a"]),
          "c1",
        ),
      });
      expect((await decide({ approved: true, remember: "bad" })).status).toBe(
        400,
      );
      expect((await decide({ approved: true, remember: "run" })).status).toBe(
        202,
      );
      expect(await first(tool, { ...call, id: "c1" }, signal())).toBe("ran");
      expect(await first(tool, { ...call, id: "c2" }, signal())).toBe("ran");
      expect(
        await first(tool, { ...call, id: "c3", args: { q: "y" } }, signal()),
      ).toMatchObject({ status: "awaiting_approval" });
      expect(
        await executor(s.identity, "chat/b")(
          tool,
          { ...call, id: "c1" },
          signal(),
        ),
      ).toMatchObject({ status: "awaiting_approval" });
      expect(execute).toHaveBeenCalledTimes(2);

      await s.storage.actions.decide(
        s.identity,
        operationId(s.identity, JSON.stringify(["chat", "b"]), "c1"),
        true,
      );
      const b = await s.storage.actions.load(
        s.identity,
        operationId(s.identity, JSON.stringify(["chat", "b"]), "c1"),
      );
      if (!b) throw new Error("missing action");
      await s.storage.actions.remember(s.identity, b, "conversation");
      expect(
        await executor(s.identity, "chat/z")(
          tool,
          { ...call, id: "c9" },
          signal(),
        ),
      ).toBe("ran");
      expect(
        await executor(s.identity, "other/z")(
          tool,
          { ...call, id: "c9" },
          signal(),
        ),
      ).toMatchObject({ status: "awaiting_approval" });
      const stranger = { ...s.identity, actorId: "stranger" };
      expect(
        await executor(stranger, "chat/z")(
          tool,
          { ...call, id: "c9" },
          signal(),
        ),
      ).toMatchObject({ status: "awaiting_approval" });
    });
    it("does not remember declined decisions", async () => {
      const s = await storageFixture(driver);
      const tool = confirmTool(readFixture("lookup"));
      const run = JSON.stringify(["chat", "a"]);
      const invoke = actionExecutor(s.storage.actions, s.identity, run);
      await invoke(tool, call, signal());
      const id = operationId(s.identity, run, call.id);
      const declined = await s.storage.actions.decide(s.identity, id, false);
      await expect(
        s.storage.actions.remember(s.identity, declined, "run"),
      ).rejects.toThrow();
      expect(await invoke(tool, { ...call, id: "c2" }, signal())).toMatchObject(
        { status: "awaiting_approval" },
      );
    });
  });
