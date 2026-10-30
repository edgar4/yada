import { describe, expect, it, vi } from "vitest";
import { drivers } from "./helpers/storage.js";
import {
  call,
  provider,
  write,
  mcpWriteFixture,
} from "./helpers/mcp-write-fixture.js";
import { createWorker } from "../src/service/worker.js";
import { actionExecutor } from "../src/service/actions.js";
import { operationId } from "../src/storage/actions.js";
import type { Tool } from "../src/core/contracts.js";
for (const driver of drivers)
  describe(`${driver} approved MCP writes`, () => {
    it("resumes an approved worker after storage and transport restart without duplicate effects or history", async () => {
      const s = await mcpWriteFixture(driver);
      const first = await s.connect();
      expect(first.tools.map((tool) => tool.spec.name)).toEqual([call.name]);
      await s.fixture.storage.jobs.submit(s.fixture.identity, "chat", {
        id: "run",
        profileId: "v1",
        input: "Change the value",
      });
      const start = (connection: { tools: readonly Tool[] }) =>
        createWorker({
          storage: s.fixture.storage,
          profiles: {
            v1: {
              provider: provider(),
              tools: connection.tools,
              system: "Help",
            },
          },
        });
      const worker = start(first);
      await worker.tick();
      await worker.stop();
      expect(
        (await s.fixture.storage.jobs.load(s.fixture.identity, "chat", "run"))
          ?.status,
      ).toBe("awaiting_approval");
      expect(s.remote.state.effects).toBe(0);
      await first.close();
      await s.fixture.reopen();
      const next = await s.connect();
      const runId = JSON.stringify(["chat", "run"]);
      await s.approve(runId);
      await s.approve(runId);
      await s.fixture.storage.jobs.update(s.fixture.identity, "chat", "run", {
        type: "queued",
      });
      const resumed = start(next);
      try {
        await resumed.tick();
        await resumed.tick();
        expect(
          (await s.fixture.storage.jobs.load(s.fixture.identity, "chat", "run"))
            ?.status,
        ).toBe("completed");
        expect(
          (
            await s.fixture.storage.conversations.load(
              s.fixture.identity,
              "chat",
            )
          )?.messages,
        ).toEqual([
          { role: "user", content: "Change the value" },
          { role: "assistant", content: "Done" },
        ]);
        expect(
          s.remote.calls.filter((entry) => entry.name === "change"),
        ).toHaveLength(1);
        expect(s.remote.state.effects).toBe(1);
        expect(
          s.remote.calls.find((entry) => entry.name === "change")?.metadata,
        ).toMatchObject({
          ...s.fixture.identity,
          operationId: operationId(s.fixture.identity, runId, call.id),
          version: "revision-1",
        });
      } finally {
        await resumed.stop();
      }
    });
    it("reconciles a committed mutation after its connection drops without another execute packet", async () => {
      const s = await mcpWriteFixture(driver);
      const first = await s.connect();
      expect(await s.run(first)).toMatchObject({ status: "awaiting_approval" });
      await s.approve();
      s.remote.state.dropReply = true;
      expect(await s.run(first)).toMatchObject({ status: "reconciling" });
      expect(s.remote.state.effects).toBe(1);
      await s.fixture.reopen();
      const next = await s.connect();
      s.remote.state.receiptsAvailable = false;
      expect(await s.run(next)).toMatchObject({ status: "reconciling" });
      s.remote.state.receiptsAvailable = true;
      expect(await s.run(next)).toEqual({ status: "completed", text: "Done" });
      expect(await s.run(next)).toEqual({ status: "completed", text: "Done" });
      expect(
        s.remote.calls.filter((entry) => entry.name === "change"),
      ).toHaveLength(1);
      expect(
        s.remote.calls.filter((entry) => entry.name === "receipt"),
      ).toHaveLength(2);
      expect(s.remote.state.effects).toBe(1);
    });
    it("recovers an external receipt when saving it locally failed", async () => {
      const s = await mcpWriteFixture(driver);
      const connection = await s.connect();
      const id = operationId(s.fixture.identity, "run", call.id);
      const receipt = vi.fn(() =>
        Promise.reject(new Error("Storage unavailable")),
      );
      const execute = actionExecutor(
        { ...s.fixture.storage.actions, receipt },
        s.fixture.identity,
        "run",
      );
      expect(
        await execute(write(connection), call, AbortSignal.timeout(5000)),
      ).toMatchObject({ status: "awaiting_approval" });
      await s.approve();
      expect(
        await execute(write(connection), call, AbortSignal.timeout(5000)),
      ).toMatchObject({ status: "reconciling" });
      expect(
        (await s.fixture.storage.actions.load(s.fixture.identity, id))?.status,
      ).toBe("executing");
      await s.fixture.reopen();
      expect(
        await actionExecutor(
          s.fixture.storage.actions,
          s.fixture.identity,
          "run",
        )(write(await s.connect()), call, AbortSignal.timeout(5000)),
      ).toBe("Changed value to Ada");
      expect(
        s.remote.calls.filter((entry) => entry.name === "change"),
      ).toHaveLength(1);
      expect(s.remote.state.effects).toBe(1);
    });
    it("rejects approval reuse after the endpoint or reviewed mapping changes", async () => {
      const s = await mcpWriteFixture(driver);
      const first = await s.connect();
      expect(await s.run(first)).toMatchObject({ status: "awaiting_approval" });
      await s.approve();
      await s.fixture.reopen();
      for (const overrides of [
        { url: "https://other.test/mcp" },
        { version: "v2" },
      ]) {
        const next = await s.connect(overrides);
        await expect(s.run(next)).rejects.toThrow();
        await expect(
          actionExecutor(s.fixture.storage.actions, s.fixture.identity, "run")(
            write(next),
            call,
            AbortSignal.timeout(5000),
          ),
        ).rejects.toThrow("mismatch");
      }
      expect(s.remote.state.effects).toBe(0);
      expect(
        s.remote.calls.filter((entry) => entry.name === "change"),
      ).toHaveLength(0);
    });
    it("blocks revocation between prepare and dispatch and denies cross-owner receipt reads", async () => {
      const s = await mcpWriteFixture(driver);
      const connection = await s.connect();
      expect(await s.run(connection)).toMatchObject({
        status: "awaiting_approval",
      });
      await s.approve();
      s.remote.state.afterPrepare = () => s.authorize.mockResolvedValue(false);
      expect(await s.run(connection)).toMatchObject({ status: "failed" });
      expect(s.remote.state.effects).toBe(0);
      s.authorize.mockResolvedValue(true);
      const before = s.remote.calls.length;
      for (const other of [
        { ...s.fixture.identity, actorId: "another" },
        { ...s.fixture.identity, tenantId: "another" },
      ])
        await expect(
          write(connection).reconcile(
            "operation",
            other,
            AbortSignal.timeout(5000),
          ),
        ).rejects.toThrow();
      expect(s.remote.calls).toHaveLength(before);
    });
  });
