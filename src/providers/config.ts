import { z } from "zod";
import { createAnthropicProvider } from "./anthropic.js";
const providerConfig = z.strictObject({
  provider: z.literal("anthropic"),
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
});
export type ProviderConfig = z.input<typeof providerConfig>;
export function createProvider(config: ProviderConfig) {
  const result = providerConfig.safeParse(config);
  if (!result.success)
    throw new Error(
      "Invalid provider configuration: choose a supported provider and provide that provider's API key; model is optional.",
    );
  return createAnthropicProvider({
    apiKey: result.data.apiKey,
    model: result.data.model,
  });
}
export function providerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ProviderConfig {
  const result = providerConfig.safeParse({
    provider: env["YADA_LLM_PROVIDER"],
    apiKey: env["YADA_LLM_API_KEY"],
    ...(env["YADA_LLM_MODEL"] === undefined
      ? {}
      : { model: env["YADA_LLM_MODEL"] }),
  });
  if (!result.success)
    throw new Error(
      "Invalid provider configuration: check YADA_LLM_PROVIDER, YADA_LLM_API_KEY, and optional YADA_LLM_MODEL.",
    );
  return result.data;
}
