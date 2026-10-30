import { afterEach, vi } from "vitest";
import { drivers, storageFixture } from "./storage.js";
import { mcpWriteServer, writeMapping } from "./mcp-write-server.js";
import { connectMcpTransport } from "../../src/connectors/mcp/session.js";
import { createFakeProvider } from "../../src/providers/fake.js";
import { actionExecutor } from "../../src/service/actions.js";
import { operationId } from "../../src/storage/actions.js";
import { runDurable } from "../../src/storage/durable-run.js";
import type { Tool } from "../../src/core/contracts.js";
export const call = {
  id: "write-1",
  name: "remote__change",
  args: { value: "Ada" },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
export const provider = () =>
  createFakeProvider((request) =>
    request.messages.some((message) => message.role === "tool")
      ? { content: "Done", toolCalls: [], finishReason: "stop" }
      : { content: "", toolCalls: [call], finishReason: "tool_calls" },
  );
export function write(connection: { tools: readonly Tool[] }) {
  const tool = connection.tools.find(
    (candidate) => candidate.effect === "write",
  );
  if (!tool) throw new Error("Missing write tool");
  return tool;
}
export async function mcpWriteFixture(driver: (typeof drivers)[number]) {
  const fixture = await storageFixture(driver);
  const remote = mcpWriteServer(fixture.identity);
  cleanups.push(() => remote.close());
  const authorize = vi.fn(() => Promise.resolve(true));
  const connect = async (
    overrides: { url?: string; version?: string } = {},
  ) => {
    const connection = await connectMcpTransport(
      {
        name: "remote",
        url: overrides.url ?? "https://example.test/mcp",
        writeTools: {
          change: {
            ...writeMapping.change,
            version: overrides.version ?? "v1",
          },
        },
      },
      { identity: fixture.identity, authorize },
      await remote.transport(),
      AbortSignal.timeout(5000),
    );
    cleanups.push(() => connection.close());
    return connection;
  };
  const run = (connection: { tools: readonly Tool[] }, runId = "run") =>
    runDurable({
      store: fixture.storage.runs,
      identity: fixture.identity,
      runId,
      profileId: "v1",
      provider: provider(),
      tools: connection.tools,
      input: "Change the value",
      system: "Help",
      signal: AbortSignal.timeout(10000),
      executeWrite: actionExecutor(
        fixture.storage.actions,
        fixture.identity,
        runId,
      ),
    });
  const approve = (runId = "run") =>
    fixture.storage.actions.decide(
      fixture.identity,
      operationId(fixture.identity, runId, call.id),
      true,
    );
  return { fixture, remote, authorize, connect, run, approve };
}
