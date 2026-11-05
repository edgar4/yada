import { z } from "zod";
import { contentSchema, maxImageChars, maxImages } from "../core/content.js";
import { runResultSchema } from "../core/checkpoint.js";
import { messageSchema } from "../storage/conversations.js";
export const jobInputSchema = z.strictObject({
  id: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128),
  input: contentSchema.refine(
    (input) =>
      typeof input === "string"
        ? input.length > 0 && input.length <= 32_000
        : input.length > 0 &&
          input.reduce(
            (total, part) =>
              total + (part.type === "text" ? part.text.length : 0),
            0,
          ) <= 32_000,
    "Invalid job input",
  ),
});
export const steeringInputSchema = z.strictObject({
  id: z.string().min(1).max(128),
  input: jobInputSchema.shape.input,
});
export const maxSteering = 8;
export const maxJobBodyBytes = maxImages * (maxImageChars + 1_024) + 98_304;
const statusSchema = z.enum([
  "queued",
  "running",
  "progress",
  "awaiting_approval",
  "reconciling",
  "completed",
  "failed",
  "cancelled",
]);
export const activityTypes = [
  "tool_started",
  "tool_finished",
  "usage",
  "steering_received",
] as const;
const tokenCount = z.number().int().nonnegative().optional();
export const usageFieldsSchema = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  serverToolCalls: tokenCount,
});
export const eventSchema = z.strictObject({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  type: z.enum([...statusSchema.options, ...activityTypes, "text_delta"]),
  at: z.number(),
  text: z.string().optional(),
  code: z.string().optional(),
  approvalId: z.string().optional(),
  expiresAt: z.number().optional(),
  tool: z.string().optional(),
  failed: z.boolean().optional(),
  ...usageFieldsSchema.shape,
});
const quotaWindowSchema = z.object({
  limit: z.number(),
  windowMs: z.number(),
});
export const quotaSnapshotSchema = z.object({
  requests: quotaWindowSchema.optional(),
  costMicros: quotaWindowSchema.optional(),
  scope: z.enum(["tenant", "actor"]).optional(),
  globalCostMicros: quotaWindowSchema.optional(),
  reserveCostMicros: z.number().optional(),
  reservationTtlMs: z.number().optional(),
});
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;
export const jobSchema = jobInputSchema.extend({
  createdAt: z.number(),
  updatedAt: z.number(),
  availableAt: z.number().default(0),
  attempts: z.number().int().nonnegative().default(0),
  status: statusSchema,
  cancelRequested: z.boolean(),
  history: z.array(messageSchema),
  steering: z
    .array(steeringInputSchema.extend({ consumed: z.boolean() }))
    .default([]),
  outcome: runResultSchema.optional(),
  events: z.array(eventSchema),
});
export type SteeringInput = z.infer<typeof steeringInputSchema>;
export type JobInput = z.infer<typeof jobInputSchema>;
export type Job = z.infer<typeof jobSchema>;
export type RunEvent = z.infer<typeof eventSchema>;
export { isTerminal } from "./terminal.js";
export const isActivity = (type: string) =>
  (activityTypes as readonly string[]).includes(type);
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410 | 415,
    message: string,
  ) {
    super(message);
  }
}
