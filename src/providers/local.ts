import { z } from "zod";
import { nativeOpenAIAdapter } from "./native/openai.js";
import { nativeOpenAIResponsesAdapter } from "./native/openai-responses.js";
import { defaultMaxRetries, openaiApi, tuning } from "./options.js";
export const localOptions = z
  .strictObject({
    provider: z.enum(["ollama", "llamacpp", "openai-compatible"]),
    model: z.string().trim().min(1),
    apiKey: z.string().trim().min(1).optional(),
    vision: z.boolean().optional(),
    api: openaiApi,
    ...tuning,
  })
  .refine((value) => value.provider !== "openai-compatible" || value.baseUrl);
const defaultUrls: Record<
  z.infer<typeof localOptions>["provider"],
  string | undefined
> = {
  ollama: "http://localhost:11434/v1",
  llamacpp: "http://localhost:8080/v1",
  "openai-compatible": undefined,
};
export function createLocalProvider(config: z.input<typeof localOptions>) {
  const { provider, api, ...options } = localOptions.parse(config);
  return (
    api === "responses" ? nativeOpenAIResponsesAdapter : nativeOpenAIAdapter
  )({
    ...options,
    name: provider,
    maxRetries: options.maxRetries ?? defaultMaxRetries,
    baseUrl: options.baseUrl ?? defaultUrls[provider],
  });
}
