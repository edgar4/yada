import { expect, it, vi } from "vitest";
import { connectMcp, readTool, reconnectingMcp } from "../src/index.js";
import type { McpConnection, ReadTool } from "../src/index.js";
import { z } from "zod";

const identity = { actorId: "a", tenantId: "t" };
it("rediscovers a restarted real stdio server", async () => {
  let latest: McpConnection | undefined;
  const authorize = vi.fn(() => Promise.resolve(true));
  const connection = await reconnectingMcp(async (signal) => {
    latest = await connectMcp(
      {
        name: "local",
        command: process.execPath,
        args: ["--import", "tsx", "tests/fixtures/mcp-server.ts"],
        readTools: ["lookup"],
      },
      { identity, authorize },
      signal,
    );
    return latest;
  });
  try {
    const tool = connection.tools[0];
    expect(
      await tool?.execute({ id: "a" }, identity, AbortSignal.timeout(5000)),
    ).toBe("Found a");
    await latest?.close();
    expect(
      await tool?.execute({ id: "b" }, identity, AbortSignal.timeout(5000)),
    ).toBe("Found b");
    authorize.mockResolvedValue(false);
    await expect(
      tool?.execute({ id: "c" }, identity, AbortSignal.timeout(5000)),
    ).rejects.toThrow("denied");
  } finally {
    await connection.close();
  }
});

it("closes a replacement created while shutdown is pending", async () => {
  const tool = readTool({
    name: "lookup",
    description: "Lookup",
    input: z.object({}),
    authorize: () => Promise.resolve(true),
    execute: () => Promise.resolve("ok"),
  });
  const first = {
    tools: [tool],
    isConnected: () => false,
    close: vi.fn(() => Promise.resolve()),
  };
  const next = { tools: [tool], close: vi.fn(() => Promise.resolve()) };
  let release: (connection: McpConnection) => void = () => undefined;
  const waiting = new Promise<McpConnection>((resolve) => {
    release = resolve;
  });
  const connect = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockImplementationOnce(() => waiting);
  const resilient = await reconnectingMcp(connect);
  await expect(
    resilient.tools[0]?.execute({}, identity, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(connect).toHaveBeenCalledOnce();
  const execution = resilient.tools[0]?.execute(
    {},
    identity,
    AbortSignal.timeout(5000),
  );
  await vi.waitFor(() => {
    expect(connect).toHaveBeenCalledTimes(2);
  });
  const closing = resilient.close();
  release(next);
  await expect(execution).rejects.toThrow("changed");
  await closing;
  expect(next.close).toHaveBeenCalledOnce();
});

const signal = () => AbortSignal.timeout(5000);
function connection(description = "lookup") {
  let connected = true;
  const authorize = vi.fn(() => Promise.resolve(true));
  const execute = vi.fn(() => Promise.resolve("ok"));
  const tool = readTool({
    name: "lookup",
    description,
    input: z.strictObject({ id: z.string() }),
    authorize,
    execute,
  });
  return {
    tools: [tool],
    isConnected: () => connected,
    disconnect() {
      connected = false;
    },
    authorize,
    execute,
    close: vi.fn(() => {
      connected = false;
      return Promise.resolve();
    }),
  };
}
it("reconnects once for concurrent calls, rediscovers matching tools, and reauthorizes", async () => {
  const first = connection();
  const second = connection();
  const connect = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const resilient = await reconnectingMcp(connect);
  const tool = resilient.tools[0] as ReadTool;
  expect(await tool.authorize(identity)).toBe(true);
  expect(resilient.isConnected?.()).toBe(true);
  first.disconnect();
  expect(
    await Promise.all([
      tool.execute({ id: "a" }, identity, signal()),
      tool.execute({ id: "b" }, identity, signal()),
    ]),
  ).toEqual(["ok", "ok"]);
  expect(connect).toHaveBeenCalledTimes(2);
  second.authorize.mockResolvedValue(false);
  await expect(tool.execute({ id: "a" }, identity, signal())).rejects.toThrow(
    "denied",
  );
  expect(second.execute).toHaveBeenCalledTimes(2);
  await resilient.close();
  expect(await tool.authorize(identity)).toBe(false);
  expect(resilient.isConnected?.()).toBe(false);
  await expect(tool.execute({}, identity, signal())).rejects.toThrow("closed");
});
it("fails closed when reconnect discovery changes and permits a later clean recovery", async () => {
  const first = connection();
  const changed = connection("changed");
  const recovered = connection();
  const connect = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(changed)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(recovered);
  const resilient = await reconnectingMcp(connect);
  first.disconnect();
  await expect(
    (resilient.tools[0] as ReadTool).execute({}, identity, signal()),
  ).rejects.toThrow("changed");
  expect(changed.close).toHaveBeenCalledOnce();
  await expect(
    (resilient.tools[0] as ReadTool).authorize(identity),
  ).rejects.toThrow("offline");
  expect(
    await (resilient.tools[0] as ReadTool).execute(
      { id: "a" },
      identity,
      signal(),
    ),
  ).toBe("ok");
  await resilient.close();
});
it("handles connections without liveness hooks", async () => {
  const original = connection();
  const basic: McpConnection = { tools: original.tools, close: original.close };
  const connect = vi.fn(() => Promise.resolve(basic));
  const resilient = await reconnectingMcp(connect);
  expect(resilient.isConnected?.()).toBe(true);
  expect(
    await (resilient.tools[0] as ReadTool).execute(
      { id: "a" },
      identity,
      signal(),
    ),
  ).toBe("ok");
  expect(connect).toHaveBeenCalledOnce();
  await resilient.close();
});
