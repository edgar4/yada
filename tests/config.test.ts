import { expect, it, vi, afterEach } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessageChunk } from "@langchain/core/messages";
import { createProvider, providerConfigFromEnv } from "../src/index.js";
afterEach(() => vi.restoreAllMocks());
it.each([undefined, "custom-model"])(
  "defaults or overrides model %s",
  async (model) => {
    const invoke = vi
      .spyOn(ChatAnthropic.prototype, "invoke")
      .mockResolvedValue(
        new AIMessageChunk({
          content: "Hello",
          response_metadata: { stop_reason: "end_turn" },
        }),
      );
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
    expect(invoke.mock.instances[0]).toHaveProperty(
      "model",
      model ?? "claude-sonnet-4-6",
    );
  },
);
it("reads common names and ignores unrelated environment", () => {
  expect(
    providerConfigFromEnv({
      LLM_PROVIDER: "anthropic",
      LLM_API_KEY: " key ",
      UNRELATED: "value",
    }),
  ).toEqual({ provider: "anthropic", apiKey: "key" });
});
it("reads optional model", () => {
  expect(
    providerConfigFromEnv({
      LLM_PROVIDER: "anthropic",
      LLM_API_KEY: "key",
      LLM_MODEL: "custom",
    }).model,
  ).toBe("custom");
});
it.each([
  {},
  { LLM_PROVIDER: "unknown", LLM_API_KEY: "secret" },
  { LLM_PROVIDER: "anthropic", LLM_API_KEY: " " },
  { LLM_PROVIDER: "anthropic", LLM_API_KEY: "secret", LLM_MODEL: "" },
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
