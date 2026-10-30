import { z } from "zod";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createGeminiProvider } from "./gemini.js";
import { createDeepSeekProvider } from "./deepseek.js";
import { createLocalProvider, localOptions } from "./local.js";
const factories = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
  gemini: createGeminiProvider,
  deepseek: createDeepSeekProvider,
};
const cloudConfig = z.strictObject({
  provider: z.enum(["anthropic", "openai", "gemini", "deepseek"]),
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
});
const providerConfig = z.union([cloudConfig, localOptions]);
export type ProviderConfig = z.input<typeof providerConfig>;
export function createProvider(config: ProviderConfig) {
  const result = providerConfig.safeParse(config);
  if (!result.success)
    throw new Error(
      "Invalid provider configuration: choose a supported provider and provide a model for local servers or an API key for hosted providers.",
    );
  if (result.data.provider === "ollama" || result.data.provider === "llamacpp")
    return createLocalProvider(result.data);
  const cloud = cloudConfig.parse(result.data);
  const factory = factories[cloud.provider];
  return factory({
    apiKey: cloud.apiKey,
    model: cloud.model,
  });
}
export function providerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ProviderConfig {
  const result = providerConfig.safeParse({
    provider: env["YADA_LLM_PROVIDER"],
    ...(env["YADA_LLM_API_KEY"]?.trim()
      ? { apiKey: env["YADA_LLM_API_KEY"] }
      : {}),
    ...(env["YADA_LLM_BASE_URL"] === undefined
      ? {}
      : { baseUrl: env["YADA_LLM_BASE_URL"] }),
    ...(env["YADA_LLM_MODEL"] === undefined
      ? {}
      : { model: env["YADA_LLM_MODEL"] }),
  });
  if (!result.success)
    throw new Error(
      "Invalid provider configuration: check YADA_LLM_PROVIDER, YADA_LLM_MODEL, YADA_LLM_API_KEY, and YADA_LLM_BASE_URL.",
    );
  return result.data;
}
