import { expect, it, vi, afterEach } from "vitest";
import { createProvider, providerConfigFromEnv } from "../src/index.js";
import { claudeReply, stubFetch } from "./helpers/http.js";
afterEach(() => vi.unstubAllGlobals());
it.each([undefined, "custom-model"])(
  "defaults or overrides model %s",
  async (model) => {
    const calls = stubFetch(() => claudeReply());
    const provider = createProvider({
      provider: "anthropic",
      apiKey: "secret",
      ...(model === undefined ? {} : { model }),
    });
    await provider.complete({
      system: "Help",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(calls[0]?.body).toMatchObject({
      model: model ?? "claude-opus-5-5",
    });
  },
);
it("reads common names and ignores unrelated environment", () => {
  expect(
    providerConfigFromEnv({
      YADA_LLM_PROVIDER: "anthropic",
      YADA_LLM_API_KEY: " key ",
      UNRELATED: "value",
    }),
  ).toEqual({ provider: "anthropic", apiKey: "key" });
});
it("reads optional model", () => {
  expect(
    providerConfigFromEnv({
      YADA_LLM_PROVIDER: "anthropic",
      YADA_LLM_API_KEY: "key",
      YADA_LLM_MODEL: "custom",
    }).model,
  ).toBe("custom");
});
it.each([
  {},
  { YADA_LLM_PROVIDER: "unknown", YADA_LLM_API_KEY: "secret" },
  { YADA_LLM_PROVIDER: "anthropic", YADA_LLM_API_KEY: " " },
  {
    YADA_LLM_PROVIDER: "anthropic",
    YADA_LLM_API_KEY: "secret",
    YADA_LLM_MODEL: "",
  },
])("rejects invalid environment without leaking secrets", (env) => {
  expect(() => providerConfigFromEnv(env)).toThrow(
    "Invalid provider configuration",
  );
  try {
    providerConfigFromEnv(env);
  } catch (error) {
    expect(String(error)).not.toContain("secret");
  }
});
it("rejects blank SDK keys", () => {
  expect(() => createProvider({ provider: "anthropic", apiKey: "" })).toThrow(
    "Invalid provider configuration",
  );
});
