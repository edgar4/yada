import { afterEach, expect, it, vi } from "vitest";
import { createProvider, providerConfigFromEnv } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
it.each(["ollama", "llamacpp"] as const)(
  "connects to %s without a key",
  async (provider) => {
    const fetchMock = vi.fn((url: unknown) => {
      expect(url).toBe(
        provider === "ollama"
          ? "http://localhost:11434/v1/chat/completions"
          : "http://localhost:8080/v1/chat/completions",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "reply",
            object: "chat.completion",
            created: 1,
            model: "local-model",
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
    const adapter = createProvider(
      providerConfigFromEnv({
        YADA_LLM_PROVIDER: provider,
        YADA_LLM_MODEL: "local-model",
        YADA_LLM_API_KEY: "",
      }),
    );
    expect(adapter.name).toBe(provider);
    expect(
      await adapter.complete({
        system: "Help",
        messages: [],
        tools: [],
        signal: AbortSignal.timeout(3000),
      }),
    ).toMatchObject({ content: "Hello", finishReason: "stop" });
  },
);
it("uses a configured server and its key", async () => {
  const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
    expect(url).toBe("https://models.example/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer server-key",
    );
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "r",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Hi" },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  await createProvider(
    providerConfigFromEnv({
      YADA_LLM_PROVIDER: "ollama",
      YADA_LLM_MODEL: "m",
      YADA_LLM_BASE_URL: "https://models.example/v1",
      YADA_LLM_API_KEY: "server-key",
    }),
  ).complete({
    system: "Help",
    messages: [],
    tools: [],
    signal: AbortSignal.timeout(3000),
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});
it.each([
  "file:///tmp/model",
  "ftp://server",
  "https://user:password@server/v1",
  "https://server/v1?key=secret",
])("rejects invalid endpoint %s", (baseUrl) => {
  expect(() =>
    createProvider({ provider: "ollama", model: "m", baseUrl }),
  ).toThrow("Invalid provider configuration");
});
it("requires a local model selection", () => {
  expect(() => providerConfigFromEnv({ YADA_LLM_PROVIDER: "ollama" })).toThrow(
    "Invalid provider configuration",
  );
});
it("continues requiring hosted provider credentials", () => {
  expect(() =>
    providerConfigFromEnv({ YADA_LLM_PROVIDER: "deepseek" }),
  ).toThrow("Invalid provider configuration");
});
