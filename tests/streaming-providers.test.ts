import { afterEach, expect, it, vi } from "vitest";
import { createProvider, type ProviderResult } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
const sse = (events: readonly [string | undefined, unknown][]) =>
  new Response(
    events
      .map(
        ([name, data]) =>
          `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const anthropicMessage = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "test",
  stop_sequence: null,
};
const anthropic = {
  complete: json({
    ...anthropicMessage,
    content: [
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "Hello world" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { id: "a" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  }),
  stream: () =>
    sse([
      [
        "message_start",
        {
          type: "message_start",
          message: {
            ...anthropicMessage,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hm" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "m" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Hello " },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "world" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup",
            input: {},
          },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"id":' },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"a"}' },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 2 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]),
};
const completion = {
  id: "c",
  created: 1,
  model: "test",
};
const openai = {
  complete: json({
    ...completion,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Hello world",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"id":"a"}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
  stream: () => {
    const chunk = (delta: unknown, finish: string | null = null) => [
      undefined,
      {
        ...completion,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      },
    ];
    return sse([
      chunk({ role: "assistant", content: "Hello " }),
      chunk({ content: "world" }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"id":' },
          },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '"a"}' } }],
      }),
      chunk({}, "tool_calls"),
      [
        undefined,
        {
          ...completion,
          object: "chat.completion.chunk",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ],
    ] as [undefined, unknown][]);
  },
};
const gemini = {
  complete: json({
    candidates: [
      {
        index: 0,
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            { text: "Hello world" },
            {
              functionCall: { name: "lookup", args: { id: "a" } },
              thoughtSignature: "signature",
            },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  }),
  stream: () =>
    sse([
      [
        undefined,
        {
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [{ text: "Hello " }] },
            },
          ],
        },
      ],
      [
        undefined,
        {
          candidates: [
            {
              index: 0,
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [
                  { text: "world" },
                  {
                    functionCall: { name: "lookup", args: { id: "a" } },
                    thoughtSignature: "signature",
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        },
      ],
    ]),
};
it.each([
  ["anthropic", anthropic],
  ["openai", openai],
  ["gemini", gemini],
] as const)(
  "streams %s into the same result as complete",
  async (name, fixture) => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        const streaming =
          String(url).includes("stream") ||
          (typeof init?.body === "string" &&
            (JSON.parse(init.body) as { stream?: boolean }).stream === true);
        requests.push(streaming);
        return Promise.resolve(
          streaming ? fixture.stream() : fixture.complete.clone(),
        );
      }),
    );
    const provider = createProvider({
      provider: name,
      apiKey: "test",
      model: "test",
      ...(name === "anthropic" ? { thinkingDisplay: "summarized" } : {}),
    });
    const request = {
      system: "Help",
      messages: [{ role: "user" as const, content: "Hi" }],
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      ],
      signal: AbortSignal.timeout(3000),
    };
    const expected = await provider.complete(request);
    const stream = provider.stream?.(request);
    if (!stream) throw new Error("Missing stream");
    const deltas: string[] = [];
    let result: ProviderResult;
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        result = next.value;
        break;
      }
      deltas.push(next.value.delta);
    }
    expect(requests).toEqual([false, true]);
    expect(deltas.join("")).toBe("Hello world");
    const fixed = (value: ProviderResult) =>
      JSON.parse(
        JSON.stringify(value).replaceAll(value.toolCalls[0]?.id ?? "", "call"),
      ) as unknown;
    expect(fixed(result)).toEqual(fixed(expected));
    expect(result.toolCalls).toMatchObject([
      { name: "lookup", args: { id: "a" } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.finishReason).toBe("tool_calls");
  },
);
