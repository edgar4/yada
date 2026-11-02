import { z } from "zod";
export const defaultMaxRetries = 2;
const baseUrl = z.url().refine((value) => {
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
export const effort = z
  .enum(["low", "medium", "high", "xhigh", "max"])
  .optional();
export const openaiApi = z.enum(["chat", "responses"]).optional();
export const thinkingDisplay = z.enum(["summarized", "omitted"]).optional();
export const promptCache = z.enum(["off", "5m", "1h"]).optional();
export const serverToolFields = {
  serverTools: z.array(z.enum(["web_search", "code_execution"])).optional(),
  webSearch: z
    .strictObject({
      maxUses: z.number().int().positive().optional(),
      allowedDomains: z.array(z.string().trim().min(1)).min(1).optional(),
    })
    .optional(),
};
export type ServerToolSettings = z.infer<z.ZodObject<typeof serverToolFields>>;
export const modelOptions = z.strictObject({
  ...modelFields,
  maxTokens: z.number().int().positive().default(8192),
  maxRetries: z.number().int().min(0).max(10).default(defaultMaxRetries),
});
export type ModelOptions = z.input<typeof modelOptions>;
export function defined<T extends object>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
