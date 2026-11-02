import { z } from "zod";
import { failureCodes } from "./contracts.js";
import { contentSchema } from "./content.js";
const call = z.object({
  id: z.string().min(1),
  name: z.string(),
  args: z.unknown(),
});
const metadata = z.object({
  provider: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export const turnSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: contentSchema }),
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
    content: contentSchema,
  }),
]);
export const runResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), text: z.string() }),
  z.object({
    status: z.literal("failed"),
    code: z.enum(failureCodes),
  }),
  z.object({ status: z.literal("cancelled") }),
]);
export const checkpointSchema = z.object({
  version: z.literal(1),
  messages: z.array(turnSchema),
  pending: z.array(call),
  rounds: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative().optional(),
  reservedCostMicros: z.number().int().nonnegative().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheWriteTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  outcome: runResultSchema.optional(),
});
export type RunCheckpoint = z.infer<typeof checkpointSchema>;
export class CheckpointError extends Error {
  constructor() {
    super("Unable to persist run checkpoint");
  }
}
