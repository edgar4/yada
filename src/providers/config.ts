import { z } from "zod";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createGeminiProvider } from "./gemini.js";
import { createDeepSeekProvider } from "./deepseek.js";
import { createLocalProvider, localOptions } from "./local.js";
import { defined, modelFields, settingFields } from "./options.js";
import type { ProviderAdapter } from "../core/contracts.js";
const factories = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
  gemini: createGeminiProvider,
  deepseek: createDeepSeekProvider,
};
const cloudConfig = z.strictObject({
  provider: z.enum(["anthropic", "openai", "gemini", "deepseek"]),
  ...modelFields,
  ...settingFields,
});
export type ProviderConfig =
  z.input<typeof cloudConfig> | z.input<typeof localOptions>;
const localProviders: readonly unknown[] = localOptions.shape.provider.options;
const providers = [
  ...cloudConfig.shape.provider.options,
  ...localOptions.shape.provider.options,
];

const envNames: Record<string, string> = {
  provider: "YADA_LLM_PROVIDER",
  apiKey: "YADA_LLM_API_KEY",
  baseUrl: "YADA_LLM_BASE_URL",
  model: "YADA_LLM_MODEL",
  fallbackModel: "YADA_LLM_FALLBACK_MODEL",
  effort: "YADA_LLM_EFFORT",
  thinkingDisplay: "YADA_LLM_THINKING_DISPLAY",
  promptCache: "YADA_LLM_PROMPT_CACHE",
  serverTools: "YADA_LLM_SERVER_TOOLS",
  headers: "YADA_LLM_HEADERS",
  vision: "YADA_LLM_VISION",
  maxTokens: "YADA_LLM_MAX_TOKENS",
  temperature: "YADA_LLM_TEMPERATURE",
  maxRetries: "YADA_LLM_MAX_RETRIES",
  timeoutMs: "YADA_LLM_TIMEOUT_MS",
  "webSearch.maxUses": "YADA_LLM_WEB_SEARCH_MAX_USES",
  "webSearch.allowedDomains": "YADA_LLM_WEB_SEARCH_DOMAINS",
};

function invalid(config: Record<string, unknown>, error: z.ZodError) {
  const messages = error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys")
      return issue.keys.map(
        (key) => `${envNames[key] ?? key} is not supported`,
      );
    const key = (
      issue.path[0] === "webSearch"
        ? issue.path.slice(0, 2)
        : issue.path.slice(0, 1)
    ).join(".");
    const name = key ? (envNames[key] ?? key) : "YADA_LLM_BASE_URL";
    if (key === "provider")
      return [`${name} must be one of ${providers.join(", ")}`];
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        config,
      );
    if (!key || value === undefined)
      return [`${name} is required for ${String(config["provider"])}`];
    if (issue.code === "invalid_value")
      return [`${name} must be one of ${issue.values.join(", ")}`];
    return [`${name} is invalid`];
  });
  return new Error(
    `Invalid provider configuration: ${[...new Set(messages)].join("; ")}.`,
  );
}

function parseConfig(input: ProviderConfig) {
  const config = defined(input) as Record<string, unknown>;
  const local = localOptions.safeParse(config);
  if (local.success) return { local: local.data };
  const cloud = cloudConfig.safeParse(config);
  if (cloud.success) return { cloud: cloud.data };
  throw invalid(
    config,
    localProviders.includes(config["provider"]) ? local.error : cloud.error,
  );
}

const retryable = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number"
    ? status === 408 || status === 429 || status >= 500
    : error instanceof Error && /Connection|Timeout/.test(error.name);
};

function withFallback(
  primary: ProviderAdapter,
  fallback: ProviderAdapter,
): ProviderAdapter {
  const failover = (error: unknown, signal: AbortSignal) => {
    if (signal.aborted || !retryable(error)) throw error;
  };
  const primaryStream = primary.stream?.bind(primary);
  const fallbackStream = fallback.stream?.bind(fallback);
  return {
    ...primary,
    async complete(request) {
      try {
        return await primary.complete(request);
      } catch (error) {
        failover(error, request.signal);
        return fallback.complete(request);
      }
    },
    ...(primaryStream &&
      fallbackStream && {
        async *stream(request) {
          let started = false;
          try {
            const run = primaryStream(request);
            for (;;) {
              const next = await run.next();
              if (next.done) return next.value;
              started = true;
              yield next.value;
            }
          } catch (error) {
            if (started) throw error;
            failover(error, request.signal);
            return yield* fallbackStream(request);
          }
        },
      }),
  };
}

export function createProvider(input: ProviderConfig): ProviderAdapter {
  const parsed = parseConfig(input);
  if (parsed.local) {
    const { fallbackModel, ...options } = parsed.local;
    const primary = createLocalProvider(options);
    return fallbackModel
      ? withFallback(
          primary,
          createLocalProvider({ ...options, model: fallbackModel }),
        )
      : primary;
  }
  const { provider, fallbackModel, ...options } = parsed.cloud;
  const primary = factories[provider](options);
  return fallbackModel
    ? withFallback(
        primary,
        factories[provider]({ ...options, model: fallbackModel }),
      )
    : primary;
}

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const json = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const flag = (value: string) =>
  value === "true" ? true : value === "false" ? false : value;

type Env = Readonly<Record<string, string | undefined>>;

export function providerConfigFromEnv(env: Env): ProviderConfig {
  const read = (key: string) => env[envNames[key] ?? ""]?.trim() || undefined;
  const number = (key: string) => {
    const value = read(key);
    return value === undefined ? undefined : Number(value);
  };
  const serverTools = read("serverTools");
  const domains = read("webSearch.allowedDomains");
  const webSearch = defined({
    maxUses: number("webSearch.maxUses"),
    allowedDomains: domains && list(domains),
  });
  const headers = read("headers");
  const vision = read("vision");
  const config = defined({
    ...Object.fromEntries(
      [
        "provider",
        "apiKey",
        "baseUrl",
        "model",
        "fallbackModel",
        "effort",
        "thinkingDisplay",
        "promptCache",
      ].map((key) => [key, read(key)]),
    ),
    ...Object.fromEntries(
      ["maxTokens", "temperature", "maxRetries", "timeoutMs"].map((key) => [
        key,
        number(key),
      ]),
    ),
    serverTools:
      serverTools && (serverTools === "none" ? [] : list(serverTools)),
    headers: headers && json(headers),
    vision: vision && flag(vision),
    ...(Object.keys(webSearch).length && { webSearch }),
  });
  const parsed = parseConfig(config as ProviderConfig);
  return parsed.local ?? parsed.cloud;
}

const priceNames = {
  inputMicrosPer1k: "YADA_LLM_PRICE_INPUT_PER_1K",
  outputMicrosPer1k: "YADA_LLM_PRICE_OUTPUT_PER_1K",
  cacheReadMicrosPer1k: "YADA_LLM_PRICE_CACHE_READ_PER_1K",
  cacheWriteMicrosPer1k: "YADA_LLM_PRICE_CACHE_WRITE_PER_1K",
} as const;

export function pricingFromEnv(env: Env) {
  const values = Object.entries(priceNames).flatMap(([key, name]) => {
    const value = env[name]?.trim();
    return value ? [[key, Number(value), name] as const] : [];
  });
  if (!values.length) return undefined;
  const bad = values.find(([, value]) => !(value >= 0));
  if (bad)
    throw new Error(`Invalid pricing configuration: ${bad[2]} is invalid.`);
  const pricing = Object.fromEntries(
    values.map(([key, value]) => [key, value]),
  );
  for (const key of ["inputMicrosPer1k", "outputMicrosPer1k"] as const)
    if (pricing[key] === undefined)
      throw new Error(
        `Invalid pricing configuration: ${priceNames[key]} is required.`,
      );
  return pricing as {
    inputMicrosPer1k: number;
    outputMicrosPer1k: number;
    cacheReadMicrosPer1k?: number;
    cacheWriteMicrosPer1k?: number;
  };
}
