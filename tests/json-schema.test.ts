import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { mcpInvoker } from "../src/connectors/mcp/rpc.js";

afterEach(() => vi.restoreAllMocks());

const invoker = (format: string) =>
  mcpInvoker(
    {} as Client,
    [
      {
        name: "tool",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", format } },
        },
      },
    ],
    () => Promise.resolve(true),
    1_000,
  );

describe("MCP schema formats", () => {
  it("validates standard formats without logging", () => {
    const warn = vi.spyOn(console, "warn");
    const { validate } = invoker("uuid");
    const id = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
    expect(validate("tool", { id })).toEqual({ id });
    expect(() => validate("tool", { id: "nope" })).toThrow(
      "Invalid MCP arguments",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("compiles uuid, date and email in Yada and the MCP SDK without noise", () => {
    const spies = [
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "log"),
    ];
    const formats = ["uuid", "date", "email"];
    for (const format of formats) invoker(format);
    new AjvJsonSchemaValidator().getValidator({
      type: "object",
      properties: Object.fromEntries(
        formats.map((format) => [format, { type: "string", format }]),
      ),
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("ignores unknown custom formats quietly", () => {
    const warn = vi.spyOn(console, "warn");
    const { validate } = invoker("x-custom");
    expect(validate("tool", { id: "anything" })).toEqual({ id: "anything" });
    expect(warn).not.toHaveBeenCalled();
  });
});
