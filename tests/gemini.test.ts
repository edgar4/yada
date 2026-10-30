import { afterEach, expect, it, vi } from "vitest";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessageChunk } from "@langchain/core/messages";
import {
  createProvider,
  providerConfigFromEnv,
  readTool,
  run,
} from "../src/index.js";
import { z } from "zod";
afterEach(() => vi.restoreAllMocks());
it.each([undefined, "custom-model"])(
  "selects Gemini and model %s",
  async (model) => {
    const invoke = vi
      .spyOn(ChatGoogleGenerativeAI.prototype, "invoke")
      .mockResolvedValue(
        new AIMessageChunk({
          content: "Hello",
          response_metadata: { finishReason: "STOP" },
        }),
      );
    const provider = createProvider(
      providerConfigFromEnv({
        YADA_LLM_PROVIDER: "gemini",
        YADA_LLM_API_KEY: "key",
        ...(model ? { YADA_LLM_MODEL: model } : {}),
      }),
    );
    expect(
      await provider.complete({
        system: "Help",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).toEqual({ content: "Hello", toolCalls: [], finishReason: "stop" });
    expect(invoke.mock.instances[0]).toHaveProperty(
      "model",
      model ?? "gemini-3.8-flash",
    );
  },
);
it("preserves Gemini signatures through a tool round trip", async () => {
  vi.spyOn(ChatGoogleGenerativeAI.prototype, "bindTools").mockImplementation(
    function (this: ChatGoogleGenerativeAI) {
      return this;
    },
  );
  const metadata = {
    __gemini_function_call_thought_signatures__: { call_1: "signature" },
  };
  const invoke = vi
    .spyOn(ChatGoogleGenerativeAI.prototype, "invoke")
    .mockResolvedValueOnce(
      new AIMessageChunk({
        content: "",
        tool_calls: [{ id: "call_1", name: "lookup", args: { id: "a" } }],
        additional_kwargs: metadata,
        response_metadata: { finishReason: "STOP" },
      }),
    )
    .mockResolvedValueOnce(
      new AIMessageChunk({
        content: "Available",
        response_metadata: { finishReason: "STOP" },
      }),
    );
  const execute = vi.fn(() => Promise.resolve("Available"));
  const result = await run({
    provider: createProvider({ provider: "gemini", apiKey: "key" }),
    tools: [
      readTool({
        name: "lookup",
        description: "Lookup",
        input: z.strictObject({ id: z.string() }),
        authorize: () => Promise.resolve(true),
        execute,
      }),
    ],
    identity: { actorId: "a", tenantId: "t" },
    input: "Find a",
    system: "Help",
    signal: new AbortController().signal,
  });
  expect(result).toEqual({ status: "completed", text: "Available" });
  expect(execute).toHaveBeenCalledOnce();
  expect(invoke.mock.calls[1]?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ additional_kwargs: metadata }),
      expect.objectContaining({ tool_call_id: "call_1", content: "Available" }),
    ]),
  );
});
it.each(["MAX_TOKENS", "SAFETY", "RECITATION"])(
  "handles Gemini finish reason %s",
  async (finishReason) => {
    vi.spyOn(ChatGoogleGenerativeAI.prototype, "invoke").mockResolvedValue(
      new AIMessageChunk({
        content: "Partial",
        response_metadata: { finishReason },
      }),
    );
    const result = await createProvider({
      provider: "gemini",
      apiKey: "key",
    }).complete({
      system: "Help",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(result.finishReason).toBe(
      finishReason === "MAX_TOKENS" ? "length" : "other",
    );
  },
);
it("rejects metadata belonging to another provider", async () => {
  await expect(
    createProvider({ provider: "gemini", apiKey: "key" }).complete({
      system: "Help",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [],
          providerMetadata: { provider: "anthropic", data: {} },
        },
      ],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Provider metadata mismatch");
});
