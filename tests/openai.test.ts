import { afterEach, expect, it, vi } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
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
  "selects OpenAI and its model %s",
  async (model) => {
    const invoke = vi.spyOn(ChatOpenAI.prototype, "invoke").mockResolvedValue(
      new AIMessageChunk({
        content: "Hello",
        response_metadata: { finish_reason: "stop" },
      }),
    );
    const provider = createProvider(
      providerConfigFromEnv({
        YADA_LLM_PROVIDER: "openai",
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
      model ?? "gpt-4.1-mini",
    );
  },
);
it("completes a tool round trip with OpenAI", async () => {
  vi.spyOn(ChatOpenAI.prototype, "bindTools").mockImplementation(function (
    this: ChatOpenAI,
  ) {
    return this;
  });
  const invoke = vi
    .spyOn(ChatOpenAI.prototype, "invoke")
    .mockResolvedValueOnce(
      new AIMessageChunk({
        content: "",
        tool_calls: [{ id: "call_1", name: "lookup", args: { id: "a" } }],
        response_metadata: { finish_reason: "tool_calls" },
      }),
    )
    .mockResolvedValueOnce(
      new AIMessageChunk({
        content: "Available",
        response_metadata: { finish_reason: "stop" },
      }),
    );
  const execute = vi.fn(() => Promise.resolve("Available"));
  const result = await run({
    provider: createProvider({ provider: "openai", apiKey: "key" }),
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
      expect.objectContaining({ tool_call_id: "call_1", content: "Available" }),
    ]),
  );
});
