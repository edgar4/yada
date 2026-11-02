import { z } from "zod";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createGeminiProvider } from "./gemini.js";
import { createDeepSeekProvider } from "./deepseek.js";
import { createLocalProvider, localOptions } from "./local.js";
import {
  defined,
  effort,
  modelFields,
  openaiApi,
  promptCache,
  serverToolFields,
  thinkingDisplay,
} from "./options.js";
const factories = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
  gemini: createGeminiProvider,
  deepseek: createDeepSeekProvider,
};
const cloudConfig = z
  .strictObject({
    provider: z.enum(["anthropic", "openai", "gemini", "deepseek"]),
    ...modelFields,
    effort,
    api: openaiApi,
    thinkingDisplay,
    promptCache,
    ...serverToolFields,
  })
  .refine((value) =>
    value.provider === "anthropic"
      ? value.temperature === undefined
      : (value.effort === undefined ||
          value.provider === "openai" ||
          value.provider === "gemini") &&
        (value.api === undefined || value.provider === "openai") &&
        value.thinkingDisplay === undefined &&
        value.promptCache === undefined,
  )
  .refine(
    (value) =>
      (value.serverTools === undefined && value.webSearch === undefined) ||
      value.provider === "anthropic" ||
      (value.provider === "openai" && value.api !== "chat") ||
      (value.provider === "gemini" && value.webSearch === undefined),
  );
const providerConfig = z.union([cloudConfig, localOptions]);
export type ProviderConfig = z.input<typeof providerConfig>;
export function createProvider(input: ProviderConfig) {
  const config = defined(input) as ProviderConfig;
  const cloud = cloudConfig.safeParse(config);
  if (cloud.success) {
    const { provider, ...options } = cloud.data;
    return factories[provider](options);
  }
  const local = localOptions.safeParse(config);
  if (local.success) return createLocalProvider(local.data);
  throw new Error(
    "Invalid provider configuration: choose a supported provider and provide a model for local and OpenAI-compatible servers or an API key for hosted providers. Anthropic does not accept temperature; effort applies only to Anthropic, OpenAI and Gemini, api only to OpenAI and OpenAI-compatible servers, and thinkingDisplay and promptCache only to Anthropic, and serverTools only to Anthropic, OpenAI Responses and Gemini (webSearch not Gemini).",
  );
}
const envFields = [
  ["YADA_LLM_API_KEY", "apiKey"],
  ["YADA_LLM_BASE_URL", "baseUrl"],
  ["YADA_LLM_MODEL", "model"],
  ["YADA_LLM_EFFORT", "effort"],
  ["YADA_LLM_PROMPT_CACHE", "promptCache"],
  ["YADA_LLM_OPENAI_API", "api"],
] as const;
const envNumbers = [
  ["YADA_LLM_MAX_TOKENS", "maxTokens"],
  ["YADA_LLM_TEMPERATURE", "temperature"],
  ["YADA_LLM_MAX_RETRIES", "maxRetries"],
] as const;
const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
export function providerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ProviderConfig {
  const result = providerConfig.safeParse({
    provider: env["YADA_LLM_PROVIDER"],
    ...Object.fromEntries(
      envFields.flatMap(([name, key]) =>
        env[name] === undefined || (key === "apiKey" && !env[name].trim())
          ? []
          : [[key, env[name]]],
      ),
    ),
    ...(env["YADA_LLM_SERVER_TOOLS"] !== undefined && {
      serverTools: list(env["YADA_LLM_SERVER_TOOLS"]),
    }),
    ...Object.fromEntries(
      envNumbers.flatMap(([name, key]) =>
        env[name] === undefined ? [] : [[key, Number(env[name].trim() || NaN)]],
      ),
    ),
  });
  if (!result.success)
    throw new Error(
      "Invalid provider configuration: check YADA_LLM_PROVIDER, YADA_LLM_MODEL, YADA_LLM_API_KEY, YADA_LLM_BASE_URL, YADA_LLM_MAX_TOKENS, YADA_LLM_TEMPERATURE, YADA_LLM_MAX_RETRIES, YADA_LLM_EFFORT, YADA_LLM_PROMPT_CACHE, YADA_LLM_OPENAI_API, and YADA_LLM_SERVER_TOOLS.",
    );
  return result.data;
}
