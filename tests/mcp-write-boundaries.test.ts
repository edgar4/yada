import { describe, expect, it, vi } from "vitest";
import { drivers } from "./helpers/storage.js";
import { call, write, mcpWriteFixture } from "./helpers/mcp-write-fixture.js";
import { actionExecutor } from "../src/service/actions.js";
import { operationId } from "../src/storage/actions.js";

for (const driver of drivers)
  describe(`${driver} MCP mutation boundaries`, () => {
    it.each(["declined", "expired", "stale"] as const)(
      "never dispatches a %s approval",
      async (mode) => {
        const s = await mcpWriteFixture(driver);
        const connection = await s.connect();
        const tool = write(connection);
        const invoke = actionExecutor(
          s.fixture.storage.actions,
          s.fixture.identity,
          "run",
          10_000,
        );
        const id = operationId(s.fixture.identity, "run", call.id);
        expect(
          await invoke(tool, call, AbortSignal.timeout(5000)),
        ).toMatchObject({ status: "awaiting_approval" });
        await s.fixture.storage.actions.decide(
          s.fixture.identity,
          id,
          mode !== "declined",
        );
        if (mode === "stale") s.remote.state.revision = "changed";
        const clock =
          mode === "expired"
            ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_000)
            : undefined;
        try {
          if (mode === "stale")
            await expect(
              invoke(tool, call, AbortSignal.timeout(5000)),
            ).rejects.toThrow("state changed");
          else
            expect(await invoke(tool, call, AbortSignal.timeout(5000))).toMatch(
              /declined|expired/,
            );
        } finally {
          clock?.mockRestore();
        }
        expect(
          s.remote.calls.filter((entry) => entry.name === "change"),
        ).toHaveLength(0);
        expect(s.remote.state.effects).toBe(0);
      },
    );
    it("keeps an uncertain write recoverable when receipt access is revoked", async () => {
      const s = await mcpWriteFixture(driver);
      const first = await s.connect();
      expect(await s.run(first)).toMatchObject({ status: "awaiting_approval" });
      await s.approve();
      s.remote.state.dropReply = true;
      expect(await s.run(first)).toMatchObject({ status: "reconciling" });
      await s.fixture.reopen();
      const next = await s.connect();
      s.authorize.mockResolvedValue(false);
      const before = s.remote.calls.length;
      const executor = actionExecutor(
        s.fixture.storage.actions,
        s.fixture.identity,
        "run",
      );
      expect(
        await executor(write(next), call, AbortSignal.timeout(5000)),
      ).toMatchObject({ status: "reconciling" });
      expect(s.remote.calls).toHaveLength(before);
      expect(
        (
          await s.fixture.storage.actions.load(
            s.fixture.identity,
            operationId(s.fixture.identity, "run", call.id),
          )
        )?.status,
      ).toBe("executing");
      s.authorize.mockResolvedValue(true);
      expect(await s.run(next)).toEqual({ status: "completed", text: "Done" });
      expect(
        s.remote.calls.filter((entry) => entry.name === "change"),
      ).toHaveLength(1);
      expect(s.remote.state.effects).toBe(1);
    });
  });
