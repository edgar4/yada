import { z } from "zod";
import { openAIChat } from "./openai.js";
import { tuning } from "./options.js";
export const localOptions = z
  .strictObject({
    provider: z.enum(["ollama", "llamacpp", "openai-compatible"]),
    model: z.string().trim().min(1),
    apiKey: z.string().trim().min(1).optional(),
    ...tuning,
  })
  .refine((value) => value.provider !== "openai-compatible" || value.baseUrl);
const defaultUrls = {
  ollama: "http://localhost:11434/v1",
  llamacpp: "http://localhost:8080/v1",
};
export function createLocalProvider(config: z.input<typeof localOptions>) {
  const { provider, ...options } = localOptions.parse(config);
  return openAIChat(provider, {
    ...options,
    maxRetries: options.maxRetries ?? 2,
    baseUrl:
      options.baseUrl ?? defaultUrls[provider as keyof typeof defaultUrls],
  });
}
