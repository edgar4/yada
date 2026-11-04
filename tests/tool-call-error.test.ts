import { describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpInvoker, requestFailure } from "../src/connectors/mcp/rpc.js";
import { actionExecutor } from "../src/service/actions.js";
import { writeTool } from "../src/core/action.js";
import { ToolCallError } from "../src/core/tool.js";
import { undeliveredOutcome, unknownOutcome } from "../src/storage/actions.js";
import { drivers, storageFixture } from "./helpers/storage.js";
import { z } from "zod";

const identity = { tenantId: "t", actorId: "a" };
const socket = (code: string) =>
  new TypeError("fetch failed", { cause: { code } });
const oauth = (cause: unknown) =>
  new Error("MCP OAuth request failed", { cause });

describe("requestFailure", () => {
  it.each([
    [new UnauthorizedError(), "unauthorized", "not_sent"],
    [new StreamableHTTPError(401, "x"), "unauthorized", "not_sent"],
    [new StreamableHTTPError(404, "x"), "session_expired", "not_sent"],
    [new StreamableHTTPError(400, "x"), "request_failed", "not_sent"],
    [new StreamableHTTPError(503, "x"), "request_failed", "maybe_sent"],
    [new Error("Not connected"), "request_failed", "not_sent"],
    [socket("ECONNREFUSED"), "request_failed", "not_sent"],
    [socket("ECONNRESET"), "request_failed", "maybe_sent"],
    [new Error("Request timed out"), "request_failed", "maybe_sent"],
    [oauth(new StreamableHTTPError(404, "x")), "session_expired", "not_sent"],
    [oauth(new Error("boom")), "oauth_failed", "maybe_sent"],
  ])("classifies %s", (error, code, delivery) => {
    expect(requestFailure(error)).toMatchObject({ code, delivery });
  });
  it("keeps flattened messages without the original error", () => {
    const failure = requestFailure(new Error("secret"));
    expect(failure.message).toBe("MCP request failed");
    expect(failure.cause).toBeUndefined();
  });
});

describe("mcpInvoker errors", () => {
  const signal = new AbortController().signal;
  const tool = {
    name: "tool",
    inputSchema: { type: "object" as const, required: ["q"] },
    outputSchema: { type: "object" as const, required: ["ok"] },
  };
  const invoker = (result: unknown, allowed = true) =>
    mcpInvoker(
      { callTool: vi.fn(() => Promise.resolve(result)) } as unknown as Client,
      [tool],
      () => Promise.resolve(allowed),
      1_000,
    );
  const content = [{ type: "text", text: "x" }];
  it.each([
    [invoker({ content }, false), { q: 1 }, "access_denied", "not_sent"],
    [invoker({ content }), {}, "invalid_arguments", "not_sent"],
    [invoker({ content, isError: true }), { q: 1 }, "tool_failed", "received"],
    [
      invoker({ content, structuredContent: {} }),
      { q: 1 },
      "invalid_output",
      "received",
    ],
  ])("reports each failure %#", async (rpc, args, code, delivery) => {
    const error: unknown = await rpc
      .call("tool", args, identity, signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolCallError);
    expect(error).toMatchObject({ code, delivery });
  });
});

describe.each(drivers)("%s undelivered actions", (driver) => {
  const signal = new AbortController().signal;
  const run = async (failure: Error) => {
    const s = await storageFixture(driver);
    const tool = writeTool({
      name: "write",
      description: "write",
      version: "1",
      input: z.object({}),
      authorize: () => Promise.resolve(true),
      prepare: () => Promise.resolve({ preview: "p", version: "1" }),
      execute: () => Promise.reject(failure),
    });
    const execute = actionExecutor(s.storage.actions, s.identity, "run");
    const call = { id: "c", name: "write", args: {} };
    const proposed = await execute(tool, call, signal);
    expect(proposed).toMatchObject({ status: "awaiting_approval" });
    const id = (proposed as { approvalId: string }).approvalId;
    await s.storage.actions.decide(s.identity, id, true);
    const first = await execute(tool, call, signal);
    const again = await execute(tool, call, signal);
    expect(again).toBe(first);
    if (failure instanceof ToolCallError && failure.delivery === "not_sent")
      await s.storage.actions.undelivered(s.identity, id);
    return {
      first,
      status: (await s.storage.actions.load(s.identity, id))?.status,
    };
  };
  it("ends as undelivered when the request was not sent", async () => {
    expect(
      await run(new ToolCallError("x", "unauthorized", "not_sent")),
    ).toEqual({ first: undeliveredOutcome, status: "undelivered" });
  });
  it("stays unknown when the request may have been sent", async () => {
    expect(
      await run(new ToolCallError("x", "request_failed", "maybe_sent")),
    ).toEqual({ first: unknownOutcome, status: "unknown" });
  });
});
