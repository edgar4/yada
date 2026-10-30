import { afterEach, expect, it, vi } from "vitest";
import {
  protocolServer,
  mutation,
  owner,
  writeConfig,
} from "./helpers/mcp-protocol.js";
import {
  reconnectingMcp,
  type Tool,
  type McpConnection,
} from "../src/index.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function setup() {
  const server = protocolServer();
  cleanups.push(() => server.close());
  return server;
}
const signal = () => AbortSignal.timeout(3000);
it("reconnects all write phases and preserves their approved policy version", async () => {
  const first = setup();
  const second = setup();
  const original = await first.connect();
  const replacement = await second.connect();
  const factory = vi
    .fn<() => Promise<McpConnection<Tool>>>()
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(replacement);
  const connection = await reconnectingMcp(factory);
  cleanups.push(() => connection.close());
  const tool = mutation(connection);
  const version = tool.version;
  await original.close();
  expect(await tool.prepare({ value: "Ada" }, owner, signal())).toEqual({
    preview: "Change",
    version: "state-1",
  });
  expect(
    await tool.execute(
      { value: "Ada" },
      {
        identity: owner,
        operationId: "operation-1",
        version: "state-1",
        signal: signal(),
      },
    ),
  ).toBe("receipt-1");
  expect(await tool.reconcile("operation-1", owner, signal())).toBeUndefined();
  expect(tool.effect).toBe("write");
  expect(tool.version).toBe(version);
  expect(factory).toHaveBeenCalledTimes(2);
  expect(second.calls.mock.calls.map(([request]) => request.name)).toEqual([
    "preview",
    "change",
    "receipt",
  ]);
  second.authorize.mockResolvedValue(false);
  await expect(tool.reconcile("operation-1", owner, signal())).rejects.toThrow(
    "denied",
  );
  expect(second.calls).toHaveBeenCalledTimes(3);
});
it.each(["effect", "version", "schema"])(
  "rejects a changed %s after reconnect",
  async (change) => {
    const first = setup();
    const second = setup();
    const original = await first.connect();
    const config =
      change === "effect"
        ? { name: "remote", url: writeConfig.url }
        : change === "version"
          ? {
              ...writeConfig,
              writeTools: {
                change: {
                  ...writeConfig.writeTools.change,
                  version: "changed",
                },
              },
            }
          : writeConfig;
    if (change === "schema") {
      const helper = second.tools.find((tool) => tool.name === "preview");
      if (!helper) throw new Error("Missing helper");
      helper.inputSchema["maxProperties"] = 10;
    }
    const next = await second.connect(config);
    const connect = vi
      .fn<() => Promise<McpConnection<Tool>>>()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(next);
    const connection = await reconnectingMcp(connect);
    cleanups.push(() => connection.close());
    await original.close();
    await expect(
      mutation(connection).reconcile("operation-1", owner, signal()),
    ).rejects.toThrow("discovery changed");
    expect(next.isConnected?.()).toBe(false);
    expect(second.calls).not.toHaveBeenCalled();
  },
);
it("never retries an uncertain execute packet and reconnects only to look up the receipt", async () => {
  const first = setup();
  const second = setup();
  first.calls.mockImplementationOnce(async () => {
    await first.server.close();
    throw new Error("private remote failure");
  });
  const original = await first.connect();
  const next = await second.connect();
  const connect = vi
    .fn<() => Promise<McpConnection<Tool>>>()
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(next);
  const connection = await reconnectingMcp(connect);
  cleanups.push(() => connection.close());
  const tool = mutation(connection);
  await expect(
    tool.execute(
      { value: "Ada" },
      {
        identity: owner,
        operationId: "operation-1",
        version: "state-1",
        signal: signal(),
      },
    ),
  ).rejects.toThrow("MCP request failed");
  expect(await tool.reconcile("operation-1", owner, signal())).toBeUndefined();
  expect(first.calls.mock.calls.map(([request]) => request.name)).toEqual([
    "change",
  ]);
  expect(second.calls.mock.calls.map(([request]) => request.name)).toEqual([
    "receipt",
  ]);
});
