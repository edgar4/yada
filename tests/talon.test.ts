import { afterEach, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderResult } from "../src/core/contracts.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import {
  createTalonProvider,
  type TalonProviderRequest,
} from "../src/integrations/talon.js";

const request = (): TalonProviderRequest => ({
  system: "Verified host policy",
  messages: [
    { role: "user", content: "Find a job" },
    { role: "assistant", toolCalls: [{ id: "a", name: "search", args: {} }] },
    {
      role: "tool",
      toolCallId: "a",
      name: "search",
      content: "untrusted data",
    },
  ],
  tools: [
    { name: "respond", description: "Structured answer", parameters: {} },
  ],
  signal: new AbortController().signal,
});
const options = { profile: "existing-profile", contextTokens: 64_000 };
const completed: ProviderResult = {
  content: "private prose",
  toolCalls: [],
  finishReason: "stop",
};
afterEach(() => vi.unstubAllGlobals());

it("bridges the real provider SDK with a mocked HTTP response", async () => {
  let body: unknown;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "completion",
            object: "chat.completion",
            created: 1,
            model: "private-model",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "private provider prose",
                  tool_calls: [
                    {
                      id: "r",
                      type: "function",
                      function: {
                        name: "respond",
                        arguments: '{"answer":"answer.unsupported"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  const adapter = createTalonProvider(
    createOpenAIProvider({ apiKey: "test", model: "private-model" }),
    options,
  );
  const result = await adapter.complete(request());
  expect(result).toEqual({
    toolCalls: [
      { id: "r", name: "respond", args: { answer: "answer.unsupported" } },
    ],
    invalidToolCalls: [],
    finishReason: "tool_calls",
  });
  expect(body).toMatchObject({
    messages: [
      { role: "system", content: "Verified host policy" },
      { role: "user", content: "Find a job" },
      {
        role: "assistant",
        tool_calls: [
          { id: "a", function: { name: "search", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "untrusted data" },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(
    /private-model|private provider prose/,
  );
});

it("preserves the host profile and request while hiding prose and private provider names", async () => {
  const provider = createFakeProvider(() => ({
    ...completed,
    toolCalls: [
      { id: "answer", name: "respond", args: { answer: "answer.jobs_found" } },
    ],
  }));
  const adapter = createTalonProvider(provider, options);
  const input = request();
  expect(adapter.name).toBe("existing-profile");
  expect(adapter.capabilities).toEqual({
    toolCalling: true,
    contextTokens: 64_000,
    streaming: false,
  });
  expect(await adapter.complete(input)).toEqual({
    toolCalls: [
      { id: "answer", name: "respond", args: { answer: "answer.jobs_found" } },
    ],
    invalidToolCalls: [],
    finishReason: "stop",
  });
  expect(provider.requests[0]).toEqual({
    ...input,
    messages: [
      input.messages[0],
      { ...input.messages[1], content: "" },
      input.messages[2],
    ],
  });
  expect(provider.requests[0]?.signal).toBe(input.signal);
  expect(input.messages[1]).not.toHaveProperty("content");
});

it("leaves malformed call arguments on the host's invalid-call repair path", async () => {
  const provider = createFakeProvider(() => ({
    ...completed,
    toolCalls: [
      { id: "valid", name: "search", args: { query: "work" } },
      { id: "array", name: "search", args: [] },
      { id: "null", name: "search", args: null },
      { id: "string", name: "search", args: "secret malformed input" },
    ],
    finishReason: "tool_calls",
  }));
  expect(
    await createTalonProvider(provider, options).complete(request()),
  ).toEqual({
    toolCalls: [{ id: "valid", name: "search", args: { query: "work" } }],
    invalidToolCalls: ["array", "null", "string"].map((id) => ({
      id,
      name: "search",
    })),
    finishReason: "tool_calls",
  });
});

it("retains normalized usage privately without manufacturing missing counts", async () => {
  const usage = { inputTokens: 12, outputTokens: 4 };
  const provider = createFakeProvider(() => ({ ...completed, usage }));
  expect(
    await createTalonProvider(provider, options).complete(request()),
  ).toMatchObject({ usage });
  expect(
    await createTalonProvider(
      createFakeProvider(() => completed),
      options,
    ).complete(request()),
  ).not.toHaveProperty("usage");
});

it("refuses continuation metadata that the host checkpoint cannot retain", async () => {
  const provider = createFakeProvider(() => ({
    ...completed,
    providerMetadata: {
      provider: "private-provider",
      data: { signature: "private-signature" },
    },
  }));
  await expect(
    createTalonProvider(provider, options).complete(request()),
  ).rejects.toThrow("Talon cannot retain provider continuation metadata");
});

it("refuses mismatched metadata and extra fields on raw function calls", async () => {
  for (const providerMetadata of [
    { provider: "another-provider", data: {} },
    {
      provider: "fake",
      data: {
        tool_calls: [
          {
            id: "r",
            type: "function",
            function: { name: "respond", arguments: "{}" },
            signature: "private-signature",
          },
        ],
      },
    },
  ]) {
    const provider = createFakeProvider(() => ({
      ...completed,
      providerMetadata,
    }));
    await expect(
      createTalonProvider(provider, options).complete(request()),
    ).rejects.toThrow("Talon cannot retain provider continuation metadata");
  }
});

it("does not call an aborted provider or accept a result after cancellation", async () => {
  const abort = new AbortController();
  const complete = vi.fn(() => Promise.resolve(completed));
  const provider: ProviderAdapter = {
    name: "test",
    capabilities: { toolCalling: true },
    complete,
  };
  abort.abort();
  await expect(
    createTalonProvider(provider, options).complete({
      ...request(),
      signal: abort.signal,
    }),
  ).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
  const later = new AbortController();
  complete.mockImplementation(() => {
    later.abort();
    return Promise.resolve(completed);
  });
  await expect(
    createTalonProvider(provider, options).complete({
      ...request(),
      signal: later.signal,
    }),
  ).rejects.toThrow();
});

it("preserves provider failures and refuses unsupported capabilities or invalid host configuration", async () => {
  const failure = new Error("provider unavailable");
  const provider = createFakeProvider(() => Promise.reject(failure));
  await expect(
    createTalonProvider(provider, options).complete(request()),
  ).rejects.toBe(failure);
  expect(() =>
    createTalonProvider(
      { ...provider, capabilities: { toolCalling: false } },
      options,
    ),
  ).toThrow("Talon requires tool calling");
  expect(() =>
    createTalonProvider(provider, { ...options, profile: "" }),
  ).toThrow();
  expect(() =>
    createTalonProvider(provider, { ...options, contextTokens: 0 }),
  ).toThrow();
});

it("rejects missing tool identity and invalid usage instead of forwarding unusable results", async () => {
  const badCall = createFakeProvider(() => ({
    ...completed,
    toolCalls: [{ id: "", name: "respond", args: {} }],
  }));
  await expect(
    createTalonProvider(badCall, options).complete(request()),
  ).rejects.toThrow();
  const badUsage = createFakeProvider(() => ({
    ...completed,
    usage: { inputTokens: -1, outputTokens: 0 },
  }));
  await expect(
    createTalonProvider(badUsage, options).complete(request()),
  ).rejects.toThrow();
});
