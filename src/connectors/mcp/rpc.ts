import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { abortable } from "../../core/abort.js";
import { contentText, imagePartSchema, maxImages } from "../../core/content.js";
import { compileSchema } from "../../core/json-schema.js";
import { ToolCallError } from "../../core/tool.js";
import type { Content, ContentPart, Identity } from "../../core/contracts.js";

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
const unreachable = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
export function requestFailure(error: unknown): ToolCallError {
  const oauth =
    error instanceof Error && error.message === "MCP OAuth request failed";
  const message = oauth ? "MCP OAuth request failed" : "MCP request failed";
  const root = oauth ? error.cause : error;
  if (root instanceof ToolCallError) return root;
  const status = root instanceof StreamableHTTPError ? root.code : undefined;
  const socket = root instanceof Error ? root.cause : undefined;
  if (root instanceof UnauthorizedError || status === 401)
    return new ToolCallError(message, "unauthorized", "not_sent");
  if (status === 404)
    return new ToolCallError(message, "session_expired", "not_sent");
  const refused =
    (status !== undefined && status >= 400 && status < 500) ||
    (root instanceof Error && root.message === "Not connected") ||
    unreachable.has((socket as { code?: string } | undefined)?.code ?? "");
  return new ToolCallError(
    message,
    oauth ? "oauth_failed" : "request_failed",
    refused ? "not_sent" : "maybe_sent",
  );
}
export const mcpAccessDenied = () =>
  new ToolCallError("MCP access denied", "access_denied", "not_sent");
function compile(schema: Record<string, unknown>) {
  if (schema["$async"] === true)
    throw new Error("Unsupported asynchronous MCP schema");
  return compileSchema(schema);
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
      throw new ToolCallError(
        "Invalid MCP arguments",
        "invalid_arguments",
        "not_sent",
      );
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
      throw mcpAccessDenied();
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
      throw new ToolCallError("MCP tool failed", "tool_failed", "received");
    }
    if (
      schema?.output &&
      (!result.structuredContent || !schema.output(result.structuredContent))
    )
      throw new ToolCallError(
        "Invalid MCP output",
        "invalid_output",
        "received",
      );
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
export function renderBlock(block: CallToolResult["content"][number]): string {
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
export function readResult(result: CallToolResult): Content {
  if (result.isError)
    return JSON.stringify({
      error: "tool_failed",
      message: result.content.map(renderBlock).join("\n").slice(0, 4000),
    });
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  let images = 0;
  const parts = result.content.map((block): ContentPart => {
    if (block.type === "image" && images < maxImages) {
      const image = imagePartSchema.safeParse({
        type: "image",
        mimeType: block.mimeType,
        data: block.data,
      });
      if (image.success) {
        images++;
        return image.data;
      }
    }
    return { type: "text", text: renderBlock(block) };
  });
  return images ? parts : result.content.map(renderBlock).join("\n");
}
export function structuredResult(
  result: CallToolResult,
): Record<string, unknown> {
  if (!result.structuredContent)
    throw new Error("MCP structured result required");
  if (Buffer.byteLength(contentText(readResult(result))) > 32_000)
    throw new Error("MCP result too large");
  return result.structuredContent;
}
