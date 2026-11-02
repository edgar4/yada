import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { storageFixture } from "./helpers/storage.js";
import { connectMcpTransport } from "../src/connectors/mcp/session.js";
import { createHandler } from "../src/service/http.js";
import { createWorker } from "../src/service/worker.js";
import { actionExecutor } from "../src/service/actions.js";
import { runDurable } from "../src/storage/durable-run.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { run } from "../src/core/runtime.js";
import { operationId } from "../src/storage/actions.js";
import type { RunCheckpoint } from "../src/core/checkpoint.js";
import type { ProviderAdapter, Tool } from "../src/core/contracts.js";

const call = { id: "c1", name: "remote__ask", args: {} };
const schema = {
  type: "object" as const,
  properties: { name: { type: "string" as const } },
  required: ["name"],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const sampler = () => ({
  ...createFakeProvider(() => ({
    content: "abcdefghijkl",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 3, outputTokens: 2 },
  })),
});
const agent = () =>
  createFakeProvider((request) =>
    request.messages.some((message) => message.role === "tool")
      ? { content: "Done", toolCalls: [], finishReason: "stop" }
      : {
          content: "",
          toolCalls: [{ ...call, args: { kind: "elicit" } }],
          finishReason: "tool_calls",
        },
  );

async function setup() {
  const s = await storageFixture("sqlite");
  const seen: { capabilities: unknown; replies: unknown[] } = {
    capabilities: undefined,
    replies: [],
  };
  const connect = async (
    flags: { sampling?: boolean; elicitation?: boolean } = {},
    provider?: ProviderAdapter,
  ) => {
    const mcp = new McpServer(
      { name: "client-requests", version: "1" },
      { capabilities: { tools: {} } },
    );
    const server = mcp.server;
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "ask",
          inputSchema: {
            type: "object" as const,
            properties: { kind: { type: "string" } },
          },
          annotations: { readOnlyHint: true },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      seen.capabilities = server.getClientCapabilities();
      const kind = (request.params.arguments as { kind?: string }).kind;
      let reply: unknown;
      try {
        if (kind === "sample")
          reply = await server.createMessage({
            messages: [{ role: "user", content: { type: "text", text: "hi" } }],
            maxTokens: 2,
          });
        else if (kind === "url")
          reply = await server.request(
            {
              method: "elicitation/create",
              params: {
                mode: "url",
                message: "Go",
                url: "https://x.test",
                elicitationId: "e",
              },
            },
            ElicitResultSchema,
          );
        else
          reply = await server.elicitInput({
            message: "Who?",
            requestedSchema: schema,
          });
      } catch (error) {
        reply = { error: (error as Error).message };
      }
      seen.replies.push(reply);
      return { content: [{ type: "text", text: JSON.stringify(reply) }] };
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const connection = await connectMcpTransport(
      { name: "remote", url: "https://example.test/mcp", ...flags },
      {
        identity: s.identity,
        authorize: () => Promise.resolve(true),
        ...(provider ? { provider } : {}),
      },
      clientTransport,
      AbortSignal.timeout(5000),
    );
    cleanups.push(async () => {
      await connection.close();
      await server.close();
    });
    return connection;
  };
  const durable = (tools: readonly Tool[], ttlMs?: number) =>
    runDurable({
      store: s.storage.runs,
      identity: s.identity,
      runId: "run",
      profileId: "v1",
      provider: agent(),
      tools,
      input: "Ask",
      system: "Help",
      signal: AbortSignal.timeout(10000),
      executeWrite: actionExecutor(s.storage.actions, s.identity, "run", ttlMs),
    });
  const id = operationId(s.identity, "run", `${call.id}:ask:0`);
  return {
    identity: s.identity,
    reopen: s.reopen,
    get storage() {
      return s.storage;
    },
    seen,
    connect,
    durable,
    id,
  };
}

describe("MCP sampling", () => {
  it("answers with the run provider, caps the reply and counts usage", async () => {
    const s = await setup();
    const connection = await s.connect({ sampling: true }, sampler());
    let checkpoint: RunCheckpoint | undefined;
    const result = await run({
      provider: createFakeProvider((request) =>
        request.messages.some((message) => message.role === "tool")
          ? { content: "Done", toolCalls: [], finishReason: "stop" }
          : {
              content: "",
              toolCalls: [{ ...call, args: { kind: "sample" } }],
              finishReason: "tool_calls",
              usage: { inputTokens: 1, outputTokens: 1 },
            },
      ),
      tools: connection.tools,
      identity: s.identity,
      input: "Ask",
      system: "Help",
      signal: AbortSignal.timeout(5000),
      persist: (next) => {
        checkpoint = next;
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ status: "completed", text: "Done" });
    expect(s.seen.replies).toEqual([
      expect.objectContaining({
        model: "fake",
        content: { type: "text", text: "abcdefgh" },
        stopReason: "maxTokens",
      }),
    ]);
    expect(checkpoint?.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 3,
    });
  });
  it("does not advertise the capability when disabled", async () => {
    const s = await setup();
    const connection = await s.connect({}, sampler());
    const tool = connection.tools[0];
    await tool?.execute(
      { kind: "sample" },
      s.identity,
      AbortSignal.timeout(5000),
    );
    expect(s.seen.capabilities).toEqual({});
    expect(s.seen.replies).toEqual([
      { error: "MCP error -32601: Method not found" },
    ]);
  });
  it("declines outside an active run", async () => {
    const s = await setup();
    const connection = await s.connect({ sampling: true }, sampler());
    await connection.tools[0]?.execute(
      { kind: "sample" },
      s.identity,
      AbortSignal.timeout(5000),
    );
    expect(s.seen.capabilities).toMatchObject({ sampling: {} });
    expect(s.seen.replies).toEqual([
      { error: "MCP error -1: MCP error -1: Sampling declined" },
    ]);
  });
});

describe("MCP elicitation", () => {
  it("advertises form mode only and declines URL requests and calls outside a run", async () => {
    const s = await setup();
    const connection = await s.connect({ elicitation: true });
    const execute = (kind: string) =>
      connection.tools[0]?.execute(
        { kind },
        s.identity,
        AbortSignal.timeout(5000),
      );
    await execute("elicit");
    await execute("url");
    expect(s.seen.capabilities).toEqual({ elicitation: { form: {} } });
    expect(s.seen.replies).toEqual([
      { action: "decline" },
      {
        error:
          "MCP error -32602: MCP error -32602: Client does not support URL-mode elicitation requests",
      },
    ]);
  });
  it("suspends, resumes after restart with approved content and answers once", async () => {
    const s = await setup();
    const first = await s.connect({ elicitation: true });
    expect(await s.durable(first.tools)).toMatchObject({
      status: "awaiting_approval",
      approvalId: s.id,
    });
    const action = await s.storage.actions.load(s.identity, s.id);
    expect(action?.preview).toContain("Who?");
    expect(action?.preview).toContain("requestedSchema");
    expect(s.seen.replies).toEqual([{ action: "cancel" }]);
    await first.close();
    await s.reopen();
    await s.storage.actions.decide(s.identity, s.id, true, { name: "Ada" });
    const next = await s.connect({ elicitation: true });
    expect(await s.durable(next.tools)).toEqual({
      status: "completed",
      text: "Done",
    });
    expect(await s.durable(next.tools)).toEqual({
      status: "completed",
      text: "Done",
    });
    expect(s.seen.replies.slice(1)).toEqual([
      { action: "accept", content: { name: "Ada" } },
    ]);
    expect((await s.storage.actions.load(s.identity, s.id))?.status).toBe(
      "completed",
    );
  });
  it("maps decline and expiry", async () => {
    const declined = await setup();
    const a = await declined.connect({ elicitation: true });
    await declined.durable(a.tools);
    await declined.storage.actions.decide(
      declined.identity,
      declined.id,
      false,
    );
    await declined.durable(a.tools);
    expect(declined.seen.replies.at(-1)).toEqual({ action: "decline" });
    const expired = await setup();
    const b = await expired.connect({ elicitation: true });
    expect(await expired.durable(b.tools, 50)).toMatchObject({
      status: "awaiting_approval",
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await expired.durable(b.tools, 50)).toEqual({
      status: "completed",
      text: "Done",
    });
    expect(expired.seen.replies.at(-1)).toEqual({ action: "cancel" });
    expect(
      (await expired.storage.actions.load(expired.identity, expired.id))
        ?.status,
    ).toBe("expired");
  });
  it("validates decision content against the requested schema", async () => {
    const s = await setup();
    const connection = await s.connect({ elicitation: true });
    await s.storage.jobs.submit(s.identity, "chat", {
      id: "run",
      profileId: "v1",
      input: "Ask",
    });
    const worker = createWorker({
      storage: s.storage,
      profiles: {
        v1: { provider: agent(), tools: connection.tools, system: "Help" },
      },
    });
    await worker.tick();
    const approvalId = operationId(
      s.identity,
      JSON.stringify(["chat", "run"]),
      `${call.id}:ask:0`,
    );
    const handler = createHandler({
      storage: s.storage,
      origins: [],
      authenticate: () => Promise.resolve(s.identity),
      authorizeProfile: () => Promise.resolve(true),
    });
    const decide = (body: unknown) =>
      handler(
        new Request(
          `http://localhost/v1/conversations/chat/runs/run/approvals/${approvalId}/decision`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
      );
    expect(
      (await decide({ approved: true, content: { name: 1 } })).status,
    ).toBe(400);
    expect((await decide({ approved: true })).status).toBe(400);
    expect(
      (await decide({ approved: false, content: { name: "x" } })).status,
    ).toBe(400);
    expect(
      (await decide({ approved: true, content: { name: "Ada" } })).status,
    ).toBe(202);
    await worker.tick();
    await worker.stop();
    expect((await s.storage.jobs.load(s.identity, "chat", "run"))?.status).toBe(
      "completed",
    );
    expect(s.seen.replies.at(-1)).toEqual({
      action: "accept",
      content: { name: "Ada" },
    });
  });
});
