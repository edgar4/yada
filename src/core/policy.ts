import type { WriteTool } from "./action.js";
import type { ReadTool, Tool } from "./contracts.js";
import { contentText } from "./content.js";
import { InvalidArguments } from "./tool.js";
export type ToolPolicy = Readonly<Record<string, "allow" | "ask" | "deny">>;
export function confirmTool(
  tool: ReadTool,
  options: { preview?: (args: unknown) => string } = {},
): WriteTool {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(tool.spec.parameters))
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return {
    effect: "write",
    version: `${tool.spec.name}:${hash.toString(16).padStart(8, "0")}`,
    spec: tool.spec,
    authorize: (identity) => tool.authorize(identity),
    prepare: (args) =>
      Promise.resolve({
        preview: (
          options.preview?.(args) ??
          `${tool.spec.name}(${JSON.stringify(args)})`
        ).slice(0, 32_000),
        version: "1",
      }),
    execute: async (args, context) => {
      try {
        return contentText(
          await tool.execute(args, context.identity, context.signal),
        );
      } catch (error) {
        if (error instanceof InvalidArguments)
          return JSON.stringify({
            error: "invalid_arguments",
            message: error.message,
          });
        throw error;
      }
    },
  };
}
const matches = (pattern: string, name: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(name);
export function applyToolPolicy(
  tools: readonly Tool[],
  policy: ToolPolicy,
): Tool[] {
  const patterns = Object.keys(policy).sort((a, b) => b.length - a.length);
  return tools.flatMap((tool) => {
    const name = tool.spec.name;
    const key = Object.hasOwn(policy, name)
      ? name
      : patterns.find((pattern) => matches(pattern, name));
    const action = key === undefined ? "allow" : policy[key];
    if (action === "deny") return [];
    return [
      action === "ask" && tool.effect === "read" ? confirmTool(tool) : tool,
    ];
  });
}
