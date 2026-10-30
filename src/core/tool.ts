import { z } from "zod";
import type { Identity, ReadTool } from "./contracts.js";
export function readTool<S extends z.ZodType>(options: {
  name: string;
  description: string;
  input: S;
  authorize: (identity: Identity) => Promise<boolean>;
  execute: (
    args: z.output<S>,
    identity: Identity,
    signal: AbortSignal,
  ) => Promise<string>;
}): ReadTool {
  return {
    effect: "read",
    spec: {
      name: options.name,
      description: options.description,
      parameters: z.toJSONSchema(options.input),
    },
    authorize: options.authorize,
    execute: async (args, identity, signal) =>
      options.execute(options.input.parse(args), identity, signal),
  };
}
