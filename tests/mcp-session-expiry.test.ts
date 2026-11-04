import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  connectMcp,
  reconnectingMcp,
  ToolCallError,
  type Tool,
} from "../src/index.js";

const identity = { actorId: "a", tenantId: "t" };
const signal = () => AbortSignal.timeout(5000);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function sessionServer() {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const write = vi.fn();
  const server: Server = createServer((request, response) => {
    void (async () => {
      const id = request.headers["mcp-session-id"] as string | undefined;
      if (id && !sessions.has(id)) {
        response.writeHead(404).end();
        return;
      }
      let transport = id ? sessions.get(id) : undefined;
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (session) => {
            sessions.set(session, created);
          },
        });
        const mcp = new McpServer({ name: "s", version: "1" });
        mcp.registerTool(
          "lookup",
          { annotations: { readOnlyHint: true } },
          () => ({ content: [{ type: "text", text: "found" }] }),
        );
        mcp.registerTool(
          "send",
          { inputSchema: { to: z.string() } },
          (args) => {
            write(args);
            return { content: [{ type: "text", text: "sent" }] };
          },
        );
        await mcp.connect(created);
        transport = created;
      }
      await transport.handleRequest(request, response);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url, sessions, write };
}

async function connect(url: string) {
  const factory = vi.fn((abort: AbortSignal) =>
    connectMcp(
      { name: "s", url, readTools: ["lookup"], confirmTools: ["send"] },
      { identity, authorize: () => Promise.resolve(true) },
      abort,
    ),
  );
  const connection = await reconnectingMcp(factory, signal());
  cleanups.push(() => connection.close());
  const find = (name: string) =>
    connection.tools.find((tool) => tool.spec.name === name) as Tool;
  return { factory, find, connection };
}

it("re-initializes and retries a read when the server expired the session", async () => {
  const { url, sessions } = await sessionServer();
  const { factory, find } = await connect(url);
  sessions.clear();
  const tool = find("s__lookup");
  if (tool.effect !== "read") throw new Error("read expected");
  await expect(tool.execute({}, identity, signal())).resolves.toBe("found");
  expect(factory).toHaveBeenCalledTimes(2);
});

it("retries an unsent write once, on a new session", async () => {
  const { url, sessions, write } = await sessionServer();
  const { factory, find } = await connect(url);
  sessions.clear();
  const tool = find("s__send");
  if (tool.effect !== "write") throw new Error("write expected");
  const context = {
    identity,
    signal: signal(),
    operationId: "op",
    version: "1",
  };
  await expect(tool.execute({ to: "x" }, context)).resolves.toBe("sent");
  expect(write).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledTimes(2);
});

it("reports a write as not sent when the new session cannot open", async () => {
  const { url, sessions, write } = await sessionServer();
  const { factory, find } = await connect(url);
  sessions.clear();
  factory.mockRejectedValueOnce(new Error("offline"));
  const tool = find("s__send");
  if (tool.effect !== "write") throw new Error("write expected");
  await expect(
    tool.execute(
      { to: "x" },
      { identity, signal: signal(), operationId: "op", version: "1" },
    ),
  ).rejects.toMatchObject({
    message: "offline",
    code: "request_failed",
    delivery: "not_sent",
  });
  expect(write).not.toHaveBeenCalled();
});

it("does not reconnect or repeat a write that may have run", async () => {
  const { url, write } = await sessionServer();
  const { factory, find } = await connect(url);
  const tool = find("s__send");
  if (tool.effect !== "write") throw new Error("write expected");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await real(...args);
    await response.text();
    return new Response("", { status: 502 });
  });
  cleanups.push(() => {
    vi.unstubAllGlobals();
    return Promise.resolve();
  });
  const error: unknown = await tool
    .execute(
      { to: "x" },
      { identity, signal: signal(), operationId: "op", version: "1" },
    )
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolCallError);
  expect(error).toMatchObject({ delivery: "maybe_sent" });
  expect(write).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledTimes(1);
});

it("shares one reconnect between concurrent expired calls", async () => {
  const { url, sessions } = await sessionServer();
  const { factory, find } = await connect(url);
  sessions.clear();
  const tool = find("s__lookup");
  if (tool.effect !== "read") throw new Error("read expected");
  await Promise.all(
    [1, 2, 3].map(async () =>
      expect(tool.execute({}, identity, signal())).resolves.toBe("found"),
    ),
  );
  expect(factory).toHaveBeenCalledTimes(2);
});
