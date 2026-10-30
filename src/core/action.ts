import { z } from "zod";
import type { Identity, ToolSpec, ToolCall } from "./contracts.js";
export type Preparation = Readonly<{ preview: string; version: string }>;
export type ActionContext = Readonly<{
  identity: Identity;
  signal: AbortSignal;
  operationId: string;
  version: string;
}>;
export interface WriteTool {
  readonly effect: "write";
  readonly version: string;
  readonly spec: ToolSpec;
  authorize(identity: Identity): Promise<boolean>;
  prepare(
    args: unknown,
    identity: Identity,
    signal: AbortSignal,
  ): Promise<Preparation>;
  execute(args: unknown, context: ActionContext): Promise<string>;
  reconcile(
    operationId: string,
    identity: Identity,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}
export type Suspension = Readonly<{
  status: "awaiting_approval" | "reconciling";
  approvalId: string;
}>;
export type ActionExecutor = ((
  tool: WriteTool,
  call: ToolCall,
  signal: AbortSignal,
) => Promise<string | Suspension>) & {
  unresolved?: (call: ToolCall) => Promise<Suspension | undefined>;
  withLease?: (token: string) => ActionExecutor;
};
export function writeTool<S extends z.ZodType>(options: {
  name: string;
  description: string;
  version: string;
  input: S;
  authorize: WriteTool["authorize"];
  prepare: (
    args: z.output<S>,
    identity: Identity,
    signal: AbortSignal,
  ) => Promise<Preparation>;
  execute: (args: z.output<S>, context: ActionContext) => Promise<string>;
  reconcile: WriteTool["reconcile"];
}): WriteTool {
  return {
    effect: "write",
    version: z.string().min(1).parse(options.version),
    spec: {
      name: options.name,
      description: options.description,
      parameters: z.toJSONSchema(options.input),
    },
    authorize: options.authorize,
    prepare: async (args, identity, signal) =>
      options.prepare(options.input.parse(args), identity, signal),
    execute: async (args, context) =>
      options.execute(options.input.parse(args), context),
    reconcile: options.reconcile,
  };
}
