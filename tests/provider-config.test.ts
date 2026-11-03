import { afterEach, expect, it, vi } from "vitest";
import {
  createProvider,
  pricingFromEnv,
  providerConfigFromEnv,
} from "../src/index.js";
import type { ProviderRequest } from "../src/index.js";
import { chatReply, claudeReply, json, stubFetch } from "./helpers/http.js";
afterEach(() => vi.unstubAllGlobals());
const base = { YADA_LLM_PROVIDER: "anthropic", YADA_LLM_API_KEY: "secret" };
const request = (): ProviderRequest => ({
  system: "Help",
  messages: [{ role: "user", content: "Hi" }],
  tools: [],
  signal: AbortSignal.timeout(5000),
});
const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return String(error);
  }
  return "";
};

it.each([
  [
    { YADA_LLM_PROVIDER: "anthropic" },
    "YADA_LLM_API_KEY is required for anthropic",
  ],
  [
    { ...base, YADA_LLM_EFFORT: "nope" },
    "YADA_LLM_EFFORT must be one of low, medium, high, xhigh, max",
  ],
  [{ ...base, YADA_LLM_MAX_TOKENS: "abc" }, "YADA_LLM_MAX_TOKENS is invalid"],
  [
    { YADA_LLM_PROVIDER: "bogus" },
    "YADA_LLM_PROVIDER must be one of anthropic",
  ],
  [
    { YADA_LLM_PROVIDER: "openai-compatible", YADA_LLM_MODEL: "m" },
    "YADA_LLM_BASE_URL is required for openai-compatible",
  ],
  [
    { ...base, YADA_LLM_WEB_SEARCH_MAX_USES: "0" },
    "YADA_LLM_WEB_SEARCH_MAX_USES is invalid",
  ],
])("names the bad field for %o", (env, expected) => {
  const text = message(() => providerConfigFromEnv(env));
  expect(text).toContain("Invalid provider configuration");
  expect(text).toContain(expected);
  expect(text).not.toContain("secret");
  expect(text).not.toContain("YADA_LLM_TEMPERATURE");
});

it("names unsupported code settings", () => {
  expect(
    message(() =>
      createProvider({ provider: "openai", apiKey: "k", api: "chat" } as never),
    ),
  ).toContain("api is not supported");
});

it("treats blank optional variables as unset", () => {
  expect(
    providerConfigFromEnv({
      ...base,
      YADA_LLM_MODEL: "",
      YADA_LLM_EFFORT: " ",
      YADA_LLM_BASE_URL: "",
      YADA_LLM_PROMPT_CACHE: "",
      YADA_LLM_MAX_TOKENS: "",
      YADA_LLM_TIMEOUT_MS: " ",
      YADA_LLM_SERVER_TOOLS: "",
      YADA_LLM_HEADERS: "",
      YADA_LLM_VISION: "",
    }),
  ).toEqual({ provider: "anthropic", apiKey: "secret" });
});

it("reads the new environment settings", () => {
  expect(
    providerConfigFromEnv({
      ...base,
      YADA_LLM_TIMEOUT_MS: "5000",
      YADA_LLM_FALLBACK_MODEL: "small",
      YADA_LLM_THINKING_DISPLAY: "omitted",
      YADA_LLM_WEB_SEARCH_MAX_USES: "3",
      YADA_LLM_WEB_SEARCH_DOMAINS: "a.com, b.com",
      YADA_LLM_HEADERS: '{"x-a":"1"}',
      YADA_LLM_VISION: "true",
    }),
  ).toEqual({
    ...{ provider: "anthropic", apiKey: "secret" },
    timeoutMs: 5000,
    fallbackModel: "small",
    thinkingDisplay: "omitted",
    webSearch: { maxUses: 3, allowedDomains: ["a.com", "b.com"] },
    headers: { "x-a": "1" },
    vision: true,
  });
  expect(() =>
    providerConfigFromEnv({ ...base, YADA_LLM_HEADERS: "{nope" }),
  ).toThrow("YADA_LLM_HEADERS is invalid");
});

it("hosted providers accept vision and local providers use it", () => {
  expect(
    createProvider({ provider: "anthropic", apiKey: "k", vision: true }),
  ).toBeDefined();
  expect(
    createProvider({ provider: "ollama", model: "m", vision: true })
      .capabilities.vision,
  ).toBe(true);
});

it.each(["anthropic", "openai", "deepseek", "gemini"] as const)(
  "times out hung %s requests",
  async (provider) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      ),
    );
    const started = Date.now();
    await expect(
      createProvider({
        provider,
        apiKey: "k",
        timeoutMs: 50,
        maxRetries: 0,
      }).complete(request()),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  },
);

it.each([
  [{}, 8192],
  [{ effort: "medium" }, 8192],
  [{ effort: "high" }, 32000],
  [{ effort: "max" }, 32000],
  [{ effort: "max", maxTokens: 100 }, 100],
] as const)("defaults max tokens for %o", async (extra, expected) => {
  const calls = stubFetch(() => claudeReply());
  await createProvider({
    provider: "anthropic",
    apiKey: "k",
    ...extra,
  }).complete(request());
  expect(calls[0]?.body).toMatchObject({ max_tokens: expected });
});

it("retries once on the fallback model after a server error", async () => {
  const calls = stubFetch((call) =>
    call === 1 ? json({ error: { message: "overloaded" } }, 529) : chatReply(),
  );
  const provider = createProvider({
    provider: "ollama",
    model: "big",
    fallbackModel: "small",
    maxRetries: 0,
  });
  await expect(provider.complete(request())).resolves.toMatchObject({
    content: "ok",
  });
  expect(calls.map((call) => call.body["model"])).toEqual(["big", "small"]);
});

it("does not fall back on client errors", async () => {
  const calls = stubFetch(() => json({ error: { message: "bad" } }, 400));
  await expect(
    createProvider({
      provider: "ollama",
      model: "big",
      fallbackModel: "small",
      maxRetries: 0,
    }).complete(request()),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

it("reads pricing from the environment", () => {
  expect(pricingFromEnv({})).toBeUndefined();
  expect(
    pricingFromEnv({
      YADA_LLM_PRICE_INPUT_PER_1K: "3000",
      YADA_LLM_PRICE_OUTPUT_PER_1K: "15000",
      YADA_LLM_PRICE_CACHE_READ_PER_1K: "300",
    }),
  ).toEqual({
    inputMicrosPer1k: 3000,
    outputMicrosPer1k: 15000,
    cacheReadMicrosPer1k: 300,
  });
  expect(() => pricingFromEnv({ YADA_LLM_PRICE_INPUT_PER_1K: "1" })).toThrow(
    "YADA_LLM_PRICE_OUTPUT_PER_1K is required",
  );
  expect(() =>
    pricingFromEnv({
      YADA_LLM_PRICE_INPUT_PER_1K: "x",
      YADA_LLM_PRICE_OUTPUT_PER_1K: "1",
    }),
  ).toThrow("YADA_LLM_PRICE_INPUT_PER_1K is invalid");
});
