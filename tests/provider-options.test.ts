import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createProvider,
  providerConfigFromEnv,
  readTool,
  run,
} from "../src/index.js";
import { claudeReply } from "./helpers/http.js";
afterEach(() => vi.unstubAllGlobals());
const env = { YADA_LLM_PROVIDER: "openai", YADA_LLM_API_KEY: "key" };
it("reads tuning and endpoint settings for hosted providers", () => {
  expect(
    providerConfigFromEnv({
      ...env,
      YADA_LLM_BASE_URL: "https://gateway.example.com/v1",
      YADA_LLM_MAX_TOKENS: "4096",
      YADA_LLM_TEMPERATURE: "0.2",
      YADA_LLM_MAX_RETRIES: "0",
    }),
  ).toEqual({
    provider: "openai",
    apiKey: "key",
    baseUrl: "https://gateway.example.com/v1",
    maxTokens: 4096,
    temperature: 0.2,
    maxRetries: 0,
  });
});
it("reads effort for anthropic", () => {
  expect(
    providerConfigFromEnv({
      YADA_LLM_PROVIDER: "anthropic",
      YADA_LLM_API_KEY: "key",
      YADA_LLM_EFFORT: "xhigh",
    }),
  ).toEqual({ provider: "anthropic", apiKey: "key", effort: "xhigh" });
});
it("reads openai-compatible settings without an api key", () => {
  expect(
    providerConfigFromEnv({
      YADA_LLM_PROVIDER: "openai-compatible",
      YADA_LLM_MODEL: "m",
      YADA_LLM_BASE_URL: "http://localhost:1234/v1",
    }),
  ).toEqual({
    provider: "openai-compatible",
    model: "m",
    baseUrl: "http://localhost:1234/v1",
  });
});
it.each([
  { YADA_LLM_MAX_TOKENS: "0" },
  { YADA_LLM_MAX_TOKENS: "1.5" },
  { YADA_LLM_MAX_TOKENS: "abc" },
  { YADA_LLM_MAX_TOKENS: " " },
  { YADA_LLM_TEMPERATURE: "-1" },
  { YADA_LLM_TEMPERATURE: "3" },
  { YADA_LLM_MAX_RETRIES: "11" },
  { YADA_LLM_MAX_RETRIES: "-1" },
  { YADA_LLM_PROVIDER: "deepseek", YADA_LLM_EFFORT: "high" },
  { YADA_LLM_PROVIDER: "gemini", YADA_LLM_OPENAI_API: "chat" },
  { YADA_LLM_PROVIDER: "anthropic", YADA_LLM_TEMPERATURE: "0.5" },
  { YADA_LLM_PROVIDER: "anthropic", YADA_LLM_EFFORT: "nope" },
  { YADA_LLM_BASE_URL: "ftp://example.com" },
  { YADA_LLM_BASE_URL: "https://user:pass@example.com/v1" },
  { YADA_LLM_BASE_URL: "https://example.com/v1?key=1" },
])("rejects invalid tuning %o", (extra) => {
  expect(() => providerConfigFromEnv({ ...env, ...extra })).toThrow(
    "Invalid provider configuration",
  );
});
it.each([
  { provider: "openai-compatible", model: "m" },
  { provider: "openai-compatible", baseUrl: "http://localhost:1/v1" },
  { provider: "openai", apiKey: "k", headers: { a: 1 } },
  { provider: "deepseek", apiKey: "k", effort: "high" },
  { provider: "deepseek", apiKey: "k", api: "chat" },
  { provider: "openai", apiKey: "k", thinkingDisplay: "omitted" },
  { provider: "anthropic", apiKey: "k", effort: "extreme" },
  { provider: "anthropic", apiKey: "k", thinkingDisplay: "full" },
  { provider: "anthropic", apiKey: "k", temperature: 0.5 },
  { provider: "ollama", model: "m", maxRetries: 99 },
])("rejects invalid config %o", (config) => {
  expect(() => createProvider(config as never)).toThrow(
    "Invalid provider configuration",
  );
});
function lookupTool() {
  return readTool({
    name: "lookup",
    description: "Lookup",
    input: z.strictObject({ id: z.string() }),
    authorize: () => Promise.resolve(true),
    execute: () => Promise.resolve("Available"),
  });
}
function runWith(provider: ReturnType<typeof createProvider>) {
  return run({
    provider,
    tools: [lookupTool()],
    identity: { actorId: "a", tenantId: "t" },
    input: "Find a",
    system: "Help",
    signal: AbortSignal.timeout(5000),
  });
}
function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}
it("sends openai-compatible requests to the configured endpoint with headers", async () => {
  const calls: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(init.body as string) as Record<string, unknown>,
      });
      return json({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello" },
          },
        ],
      });
    }),
  );
  const result = await run({
    provider: createProvider({
      provider: "openai-compatible",
      model: "vendor/model",
      baseUrl: "https://gateway.example.com/api/v1",
      headers: { "x-team": "yada" },
      temperature: 0.3,
    }),
    tools: [],
    identity: { actorId: "a", tenantId: "t" },
    input: "Hi",
    system: "Help",
    signal: AbortSignal.timeout(5000),
  });
  expect(result).toEqual({ status: "completed", text: "Hello" });
  expect(calls[0]?.url).toBe(
    "https://gateway.example.com/api/v1/chat/completions",
  );
  expect(calls[0]?.headers.get("x-team")).toBe("yada");
  expect(calls[0]?.body).toMatchObject({
    model: "vendor/model",
    temperature: 0.3,
  });
});
it("applies the default max tokens and a custom base URL to hosted providers", async () => {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      urls.push(url);
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return json({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello" },
          },
        ],
      });
    }),
  );
  await createProvider({
    provider: "openai",
    api: "chat",
    apiKey: "k",
    baseUrl: "https://proxy.example.com/v1",
  }).complete({
    system: "s",
    messages: [],
    tools: [],
    signal: AbortSignal.timeout(5000),
  });
  expect(urls[0]).toBe("https://proxy.example.com/v1/chat/completions");
  expect(
    bodies[0]?.["max_completion_tokens"] ?? bodies[0]?.["max_tokens"],
  ).toBe(8192);
});
it("retries transient failures and stops when aborted", async () => {
  const fetchMock = vi.fn(() => json({ error: { message: "busy" } }, 503));
  vi.stubGlobal("fetch", fetchMock);
  const provider = createProvider({
    provider: "openai-compatible",
    model: "m",
    baseUrl: "http://localhost:1/v1",
    maxRetries: 1,
  });
  const request = {
    system: "s",
    messages: [],
    tools: [],
    signal: AbortSignal.timeout(10000),
  };
  await expect(provider.complete(request)).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const controller = new AbortController();
  fetchMock.mockClear();
  fetchMock.mockImplementation(() => {
    controller.abort();
    return json({ error: { message: "busy" } }, 503);
  });
  await expect(
    provider.complete({ ...request, signal: controller.signal }),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("round trips Claude 5 thinking blocks and sends effort through a tool loop", async () => {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const thinking = { type: "thinking", thinking: "", signature: "sig" };
  const redacted = { type: "redacted_thinking", data: "opaque" };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      urls.push(url);
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      const first = bodies.length === 1;
      return Promise.resolve(
        claudeReply(
          first
            ? [
                thinking,
                redacted,
                { type: "text", text: "Checking" },
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "lookup",
                  input: { id: "a" },
                },
              ]
            : [{ type: "text", text: "Available" }],
          first ? "tool_use" : "end_turn",
        ),
      );
    }),
  );
  const result = await runWith(
    createProvider({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-test",
      baseUrl: "https://claude.example.com",
      effort: "high",
      thinkingDisplay: "summarized",
    }),
  );
  expect(result).toEqual({ status: "completed", text: "Available" });
  expect(urls[0]).toBe("https://claude.example.com/v1/messages");
  expect(bodies[0]).toMatchObject({
    max_tokens: 8192,
    output_config: { effort: "high" },
    thinking: { type: "adaptive", display: "summarized" },
  });
  expect(bodies[0]).not.toHaveProperty("temperature");
  const assistant = (
    bodies[1]?.["messages"] as { role: string; content: { type: string }[] }[]
  ).find((message) => message.role === "assistant");
  expect(assistant?.content.map((block) => block.type)).toEqual([
    "thinking",
    "redacted_thinking",
    "text",
    "tool_use",
  ]);
  expect(assistant?.content[0]).toMatchObject({
    thinking: "",
    signature: "sig",
  });
});
it("uses the documented OpenAI default with reasoning disabled", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return json({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello" },
          },
        ],
      });
    }),
  );
  const request = {
    system: "s",
    messages: [],
    tools: [],
    signal: AbortSignal.timeout(5000),
  };
  await createProvider({
    provider: "openai",
    api: "chat",
    apiKey: "k",
  }).complete(request);
  await createProvider({
    provider: "openai",
    api: "chat",
    apiKey: "k",
    model: "x",
  }).complete(request);
  expect(bodies[0]).toMatchObject({
    model: "gpt-6-luna",
    reasoning_effort: "none",
  });
  expect(bodies[1]).not.toHaveProperty("reasoning_effort");
});
