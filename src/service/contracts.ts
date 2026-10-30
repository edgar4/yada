import { z } from "zod";
import { runResultSchema } from "../core/checkpoint.js";
export const jobInputSchema = z.strictObject({
  id: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128),
  input: z.string().min(1).max(32_000),
});
export const eventSchema = z.strictObject({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  type: z.enum([
    "queued",
    "running",
    "progress",
    "awaiting_approval",
    "reconciling",
    "completed",
    "failed",
    "cancelled",
  ]),
  at: z.number(),
  text: z.string().optional(),
  code: z.string().optional(),
  approvalId: z.string().optional(),
});
export const jobSchema = jobInputSchema.extend({
  createdAt: z.number(),
  updatedAt: z.number(),
  availableAt: z.number().default(0),
  status: eventSchema.shape.type,
  cancelRequested: z.boolean(),
  history: z.array(
    z.object({ role: z.enum(["user", "assistant"]), content: z.string() }),
  ),
  outcome: runResultSchema.optional(),
  events: z.array(eventSchema),
});
export type JobInput = z.infer<typeof jobInputSchema>;
export type Job = z.infer<typeof jobSchema>;
export type RunEvent = z.infer<typeof eventSchema>;
export const isTerminal = (status: Job["status"]) =>
  status === "completed" || status === "failed" || status === "cancelled";
