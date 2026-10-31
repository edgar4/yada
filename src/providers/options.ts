import { z } from "zod";
export const baseUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
export const tuning = {
  baseUrl: baseUrl.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
};
export const modelFields = {
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  ...tuning,
};
export const thinking = z
  .strictObject({ budgetTokens: z.number().int().min(1024) })
  .optional();
export const modelOptions = z.strictObject({
  ...modelFields,
  maxTokens: z.number().int().positive().default(8192),
  maxRetries: z.number().int().min(0).max(10).default(2),
});
export type ModelOptions = z.input<typeof modelOptions>;
export function defined<T extends object>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
