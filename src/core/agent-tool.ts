import { z } from "zod";
import type { Identity, ProviderAdapter, ReadTool, Tool } from "./contracts.js";
import { composeHooks, type RunHooks } from "./hooks.js";
import type { RunLimits } from "./limits.js";
import { Suspended } from "./action.js";
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
  authorize?: (identity: Identity) => Promise<boolean>;
}): ReadTool {
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
    authorize: options.authorize ?? (() => Promise.resolve(true)),
    execute: async ({ task }, identity, signal, toolRun) => {
      const limits = options.limits ?? toolRun?.limits;
      const child = {
        provider: options.provider,
        tools: options.tools,
        identity,
        input: task,
        system: options.system,
        signal,
        ...(limits ? { limits } : {}),
        ...(options.maxRounds ? { maxRounds: options.maxRounds } : {}),
        ...(options.hooks ? { hooks: options.hooks } : {}),
      };
      const nested = toolRun?.runChild;
      const { result, usage } = nested
        ? await nested(child)
        : {
            result: await run({
              ...child,
              hooks: composeHooks(options.hooks ?? {}, {
                onEvent(event) {
                  if (event.type === "model_finished")
                    toolRun?.addUsage(event.usage);
                  return undefined;
                },
              }),
            }),
            usage: undefined,
          };
      signal.throwIfAborted();
      const suspended =
        result.status === "awaiting_approval" ||
        result.status === "reconciling";
      if (!suspended) toolRun?.addUsage(usage);
      if (suspended) throw new Suspended(result);
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
