import { z } from "zod";
const call = z.object({
  id: z.string().min(1),
  name: z.string(),
  args: z.unknown(),
});
const metadata = z.object({
  provider: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const turn = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string() }),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z.array(call),
      providerMetadata: metadata.optional(),
    })
    .transform(({ providerMetadata, ...rest }) => ({
      ...rest,
      ...(providerMetadata ? { providerMetadata } : {}),
    })),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
  }),
]);
export const runResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), text: z.string() }),
  z.object({
    status: z.literal("failed"),
    code: z.enum([
      "limit",
      "unsupported",
      "invalid_response",
      "tool_denied",
      "dependency_failed",
    ]),
  }),
  z.object({ status: z.literal("cancelled") }),
]);
export const checkpointSchema = z.object({
  version: z.literal(1),
  messages: z.array(turn),
  pending: z.array(call),
  rounds: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  outcome: runResultSchema.optional(),
});
export type RunCheckpoint = z.infer<typeof checkpointSchema>;
export class CheckpointError extends Error {
  constructor() {
    super("Unable to persist run checkpoint");
  }
}
