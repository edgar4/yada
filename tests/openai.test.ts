import { afterEach, expect, it, vi } from "vitest";
import {
  createProvider,
  providerConfigFromEnv,
  readTool,
  run,
} from "../src/index.js";
import { z } from "zod";
import { chatReply, stubFetch } from "./helpers/http.js";
afterEach(() => vi.unstubAllGlobals());
it.each([undefined, "custom-model"])(
  "selects OpenAI and its model %s",
  async (model) => {
    const calls = stubFetch(() => chatReply({ content: "Hello" }));
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
    expect(calls[0]?.body).toMatchObject({ model: model ?? "gpt-6-luna" });
  },
);
it("completes a tool round trip with OpenAI", async () => {
  const calls = stubFetch((call) =>
    call === 1
      ? chatReply(
          {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"id":"a"}' },
              },
            ],
          },
          "tool_calls",
        )
      : chatReply({ content: "Available" }),
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
  expect(calls[1]?.body["messages"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tool_call_id: "call_1", content: "Available" }),
    ]),
  );
});
