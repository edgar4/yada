import { z } from "zod";
export const modelOptions = z.strictObject({
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  maxTokens: z.number().int().positive().default(1024),
});
export type ModelOptions = z.input<typeof modelOptions>;
