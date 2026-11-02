import { z } from "zod";
import type { Content, Identity, ReadTool, ToolRun } from "./contracts.js";
export class InvalidArguments extends Error {}
export function readTool<S extends z.ZodType>(options: {
  name: string;
  description: string;
  input: S;
  timeoutMs?: number;
  authorize: (identity: Identity) => Promise<boolean>;
  execute: (
    args: z.output<S>,
    identity: Identity,
    signal: AbortSignal,
    run?: ToolRun,
  ) => Promise<Content>;
}): ReadTool {
  return {
    effect: "read",
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    spec: {
      name: options.name,
      description: options.description,
      parameters: z.toJSONSchema(options.input),
    },
    authorize: options.authorize,
    execute: async (args, identity, signal, run) => {
      const parsed = options.input.safeParse(args);
      if (!parsed.success)
        throw new InvalidArguments(
          parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "(root)"}: ${issue.message}`,
            )
            .join("; "),
        );
      return options.execute(parsed.data, identity, signal, run);
    },
  };
}
