import { afterEach, expect, it, vi } from "vitest";
import { createProvider, providerConfigFromEnv } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
it.each([undefined, "deepseek-v4-pro"])(
  "routes DeepSeek requests with model %s and its own key",
  async (model) => {
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      expect(_url).toBe("https://api.deepseek.com/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer deepseek-test-key",
      );
      if (typeof init?.body !== "string") throw new Error("Expected JSON body");
      expect(JSON.parse(init.body)).toMatchObject({
        model: model ?? "deepseek-flash",
        thinking: { type: "disabled" },
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "reply",
            object: "chat.completion",
            created: 1,
            model: "test",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "Hello" },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider(
      providerConfigFromEnv({
        YADA_LLM_PROVIDER: "deepseek",
        YADA_LLM_API_KEY: "deepseek-test-key",
        ...(model ? { YADA_LLM_MODEL: model } : {}),
      }),
    );
    expect(provider.name).toBe("deepseek");
    expect(
      await provider.complete({
        system: "Help",
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        signal: AbortSignal.timeout(3000),
      }),
    ).toMatchObject({ content: "Hello", toolCalls: [], finishReason: "stop" });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);
it("rejects blank DeepSeek credentials", () => {
  expect(() => createProvider({ provider: "deepseek", apiKey: " " })).toThrow(
    "Invalid provider configuration",
  );
});
it("cancels DeepSeek before HTTP dispatch", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    createProvider({ provider: "deepseek", apiKey: "test" }).complete({
      system: "Help",
      messages: [],
      tools: [],
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
