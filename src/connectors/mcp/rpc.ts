import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv } from "ajv";
import { z } from "zod";
import { abortable } from "../../core/abort.js";
import type { Identity } from "../../core/contracts.js";

export type McpInvoke = (
  name: string,
  args: unknown,
  identity: Identity,
  signal: AbortSignal,
  meta?: Record<string, unknown>,
) => Promise<CallToolResult>;
export type McpValidate = (
  name: string,
  args: unknown,
) => Record<string, unknown>;
function requestFailure(error: unknown): Error {
  return new Error(
    error instanceof Error && error.message === "MCP OAuth request failed"
      ? "MCP OAuth request failed"
      : "MCP request failed",
  );
}
function compile(schema: Record<string, unknown>) {
  if (schema["$async"] === true)
    throw new Error("Unsupported asynchronous MCP schema");
  const validator =
    schema["$schema"] === "https://json-schema.org/draft/2020-12/schema"
      ? new Ajv2020({ strict: false })
      : new Ajv({ strict: false });
  return validator.compile(schema);
}
export function mcpInvoker(
  client: Client,
  tools: readonly Tool[],
  authorize: (identity: Identity, name: string) => Promise<boolean>,
  timeout: number,
) {
  const schemas = new Map(
    tools.map((tool) => [
      tool.name,
      {
        input: compile(tool.inputSchema),
        output: tool.outputSchema ? compile(tool.outputSchema) : undefined,
      },
    ]),
  );
  const validate: McpValidate = (name, args) => {
    const input = z.record(z.string(), z.unknown()).parse(args);
    const schema = schemas.get(name);
    if (
      !schema ||
      !schema.input(input) ||
      Buffer.byteLength(JSON.stringify(input)) > 32_000
    )
      throw new Error("Invalid MCP arguments");
    return input;
  };
  const invoke = async (
    name: string,
    args: unknown,
    identity: Identity,
    signal: AbortSignal,
    meta: Record<string, unknown> | undefined,
    tolerateError: boolean,
  ): Promise<CallToolResult> => {
    if (!(await abortable(() => authorize(identity, name), signal)))
      throw new Error("MCP access denied");
    const input = validate(name, args);
    const schema = schemas.get(name);
    let result: CallToolResult;
    try {
      result = CallToolResultSchema.parse(
        await client.callTool(
          { name, arguments: input, ...(meta ? { _meta: meta } : {}) },
          undefined,
          { signal, timeout },
        ),
      );
    } catch (error) {
      throw requestFailure(error);
    }
    if (result.isError) {
      if (tolerateError) return result;
      throw new Error("MCP tool failed");
    }
    if (
      schema?.output &&
      (!result.structuredContent || !schema.output(result.structuredContent))
    )
      throw new Error("Invalid MCP output");
    return result;
  };
  const call: McpInvoke = (name, args, identity, signal, meta) =>
    invoke(name, args, identity, signal, meta, false);
  const read = (
    name: string,
    args: unknown,
    identity: Identity,
    signal: AbortSignal,
  ) => invoke(name, args, identity, signal, undefined, true);
  return { call, read, validate };
}
function renderBlock(block: CallToolResult["content"][number]): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
    case "audio":
      return `[${block.type}: ${block.mimeType}]`;
    case "resource":
      return `[resource: ${block.resource.uri}]`;
    case "resource_link":
      return `[resource_link: ${block.uri} ${block.name}]`;
  }
}
export function readResult(result: CallToolResult): string {
  if (result.isError)
    return JSON.stringify({
      error: "tool_failed",
      message: result.content.map(renderBlock).join("\n").slice(0, 4000),
    });
  const output = result.structuredContent
    ? JSON.stringify(result.structuredContent)
    : result.content.map(renderBlock).join("\n");
  if (Buffer.byteLength(output) > 32_000)
    throw new Error("MCP result too large");
  return output;
}
export function structuredResult(
  result: CallToolResult,
): Record<string, unknown> {
  if (!result.structuredContent)
    throw new Error("MCP structured result required");
  readResult(result);
  return result.structuredContent;
}
