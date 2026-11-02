import { z } from "zod";
import { nativeOpenAIAdapter } from "./native/openai.js";
import { defaultMaxRetries, settingFields, tuning } from "./options.js";
export const localOptions = z
  .strictObject({
    provider: z.enum(["ollama", "llamacpp", "openai-compatible"]),
    model: z.string().trim().min(1),
    apiKey: z.string().trim().min(1).optional(),
    ...tuning,
    ...settingFields,
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
  const { provider, ...options } = localOptions.parse(config);
  return nativeOpenAIAdapter({
    ...options,
    name: provider,
    maxRetries: options.maxRetries ?? defaultMaxRetries,
    baseUrl: options.baseUrl ?? defaultUrls[provider],
  });
}
