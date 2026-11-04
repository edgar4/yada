import { expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { compileSchema } from "../src/core/json-schema.js";
import { mcpInvoker } from "../src/connectors/mcp/rpc.js";

vi.mock("../src/core/json-schema.js", async (original) => {
  const actual = await original<typeof import("../src/core/json-schema.js")>();
  return { ...actual, compileSchema: vi.fn(actual.compileSchema) };
});

it("compiles an identical schema once across connections", () => {
  const tool = {
    name: "cached",
    inputSchema: { type: "object" as const, title: "only-in-this-test" },
  };
  const connect = () =>
    mcpInvoker({} as Client, [tool], () => Promise.resolve(true), 1000);
  connect();
  connect();
  expect(compileSchema).toHaveBeenCalledOnce();
  expect(connect().validate("cached", {})).toEqual({});
});
