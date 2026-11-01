import { z } from "zod";
import type { ProviderAdapter, ReadTool, Tool } from "./contracts.js";
import type { RunHooks } from "./hooks.js";
import type { RunLimits } from "./limits.js";
import { run } from "./runtime.js";
import { readTool } from "./tool.js";
const maxDepth = 2;
const depths = new WeakMap<ReadTool, number>();
export function agentTool(options: {
  name: string;
  description: string;
  provider: ProviderAdapter;
  tools: readonly Tool[];
  system: string;
  limits?: RunLimits;
  maxRounds?: number;
  hooks?: RunHooks;
}): ReadTool {
  if (options.tools.some((tool) => tool.effect === "write"))
    throw new Error("Sub-agents cannot use write tools");
  const depth =
    1 +
    Math.max(
      0,
      ...options.tools.map((tool) => depths.get(tool as ReadTool) ?? 0),
    );
  if (depth > maxDepth) throw new Error("Sub-agents are nested too deeply");
  const tool = readTool({
    name: options.name,
    description: options.description,
    input: z.strictObject({ task: z.string().min(1) }),
    authorize: () => Promise.resolve(true),
    execute: async ({ task }, identity, signal) => {
      const result = await run({
        provider: options.provider,
        tools: options.tools,
        identity,
        input: task,
        system: options.system,
        signal,
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.maxRounds ? { maxRounds: options.maxRounds } : {}),
        ...(options.hooks ? { hooks: options.hooks } : {}),
      });
      signal.throwIfAborted();
      if (result.status === "completed") return result.text;
      return JSON.stringify({
        error: "agent_failed",
        message:
          result.status === "failed"
            ? `The sub-agent failed: ${result.code}`
            : "The sub-agent did not finish",
      });
    },
  });
  depths.set(tool, depth);
  return tool;
}
