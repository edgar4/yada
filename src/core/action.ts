import { Ajv } from "ajv";
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
  reconcile?(
    operationId: string,
    identity: Identity,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}
export type Suspension = Readonly<{
  status: "awaiting_approval" | "reconciling";
  approvalId: string;
}>;
export const elicitationTool = "mcp_elicitation";
export type Elicitation = Readonly<{
  message: string;
  requestedSchema: Record<string, unknown>;
}>;
export type ElicitAnswer =
  | Readonly<{ action: "accept"; content: Record<string, unknown> }>
  | Readonly<{ action: "decline" | "cancel" }>;
export type Ask = (request: Elicitation) => Promise<ElicitAnswer | Suspension>;
export class Suspended extends Error {
  constructor(readonly suspension: Suspension) {
    super("Run suspended");
  }
}
export function validElicitation(
  action: Readonly<{ args: unknown }>,
  content: unknown,
) {
  const { requestedSchema } = action.args as Elicitation;
  return new Ajv({ strict: false }).validate(requestedSchema, content);
}
export type ActionExecutor = ((
  tool: WriteTool,
  call: ToolCall,
  signal: AbortSignal,
) => Promise<string | Suspension>) & {
  unresolved?: (call: ToolCall) => Promise<Suspension | undefined>;
  withLease?: (token: string) => ActionExecutor;
  ask?: (call: ToolCall) => Ask;
};
export const subPrefix = (callId: string) => `sub:${callId}:`;
export function scopedExecutor(
  parent: ActionExecutor,
  callId: string,
): ActionExecutor {
  const scope = (call: ToolCall) => ({
    ...call,
    id: subPrefix(callId) + call.id,
  });
  const execute: ActionExecutor = (tool, call, signal) =>
    parent(tool, scope(call), signal);
  const { unresolved, ask } = parent;
  if (unresolved) execute.unresolved = (call) => unresolved(scope(call));
  if (ask) execute.ask = (call) => ask(scope(call));
  return execute;
}
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
  reconcile?: WriteTool["reconcile"];
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
    ...(options.reconcile ? { reconcile: options.reconcile } : {}),
  };
}
