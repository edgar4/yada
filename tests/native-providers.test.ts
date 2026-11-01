import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/index.js";
import type { ProviderRequest, Turn } from "../src/index.js";
import { chatReply, claudeReply, json, stubFetch } from "./helpers/http.js";
afterEach(() => vi.unstubAllGlobals());
const request = (messages: Turn[] = [{ role: "user", content: "Hi" }]) =>
  ({
    system: "Help",
    messages,
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: { id: { type: "string" } } },
      },
    ],
    signal: AbortSignal.timeout(5000),
  }) satisfies ProviderRequest;
const image = {
  type: "image",
  mimeType: "image/png",
  data: "aGVsbG8=",
} as const;
const anthropic = () =>
  createProvider({ provider: "anthropic", apiKey: "k", model: "c" });
const openai = (extra: object = {}) =>
  createProvider({ provider: "openai", apiKey: "k", model: "m", ...extra });

describe("anthropic", () => {
  it("completes with a large max_tokens through streaming", async () => {
    const calls = stubFetch(() => claudeReply());
    const provider = createProvider({
      provider: "anthropic",
      apiKey: "k",
      model: "m",
      maxTokens: 64000,
    });
    expect(await provider.complete(request())).toMatchObject({
      content: "ok",
    });
    expect(calls[0]?.body).toMatchObject({ max_tokens: 64000, stream: true });
  });

  it("sends tools, system prompt and merges tool results into one user message", async () => {
    const calls = stubFetch(() => claudeReply());
    await anthropic().complete(
      request([
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "t1", name: "lookup", args: { id: "a" } },
            { id: "t2", name: "lookup", args: { id: "b" } },
          ],
        },
        { role: "tool", toolCallId: "t1", name: "lookup", content: "A" },
        {
          role: "tool",
          toolCallId: "t2",
          name: "lookup",
          content: [{ type: "text", text: "B" }, image],
        },
        { role: "user", content: "Thanks" },
      ]),
    );
    expect(calls[0]?.body).toMatchObject({
      system: "Help",
      max_tokens: 8192,
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          input_schema: { type: "object" },
        },
      ],
    });
    expect(calls[0]?.body).not.toHaveProperty("temperature");
    expect(calls[0]?.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "lookup", input: { id: "a" } },
          { type: "tool_use", id: "t2", name: "lookup", input: { id: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "A" },
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: [
              { type: "text", text: "B" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "aGVsbG8=",
                },
              },
            ],
          },
          { type: "text", text: "Thanks" },
        ],
      },
    ]);
  });

  it.each([
    ["end_turn", "stop"],
    ["tool_use", "tool_calls"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["refusal", "refusal"],
    ["pause_turn", "other"],
  ])("maps stop reason %s to %s", async (reason, expected) => {
    stubFetch(() => claudeReply([{ type: "text", text: "x" }], reason));
    expect((await anthropic().complete(request())).finishReason).toBe(expected);
  });

  it("replays legacy and native thinking metadata unchanged and in order", async () => {
    const blocks = [
      { type: "redacted_thinking", data: "opaque" },
      { type: "thinking", thinking: "hm", signature: "sig" },
    ];
    const calls = stubFetch((n) =>
      n === 1
        ? claudeReply([
            ...blocks,
            { type: "text", text: "Checking" },
            { type: "tool_use", id: "t1", name: "lookup", input: {} },
          ])
        : claudeReply(),
    );
    const first = await anthropic().complete(request());
    expect(first.providerMetadata).toEqual({
      provider: "anthropic",
      data: {
        contentBlocks: [
          ...blocks,
          { type: "text", text: "Checking" },
          { type: "tool_use", id: "t1", name: "lookup", input: {} },
        ],
      },
    });
    await anthropic().complete(
      request([
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: first.content,
          toolCalls: [{ id: "t1-r2", name: "lookup", args: {} }],
          ...(first.providerMetadata && {
            providerMetadata: first.providerMetadata,
          }),
        },
        { role: "tool", toolCallId: "t1", name: "lookup", content: "A" },
      ]),
    );
    const assistant = (
      calls[1]?.body["messages"] as { role: string; content: unknown[] }[]
    )[1];
    expect(assistant?.content).toEqual([
      ...blocks,
      { type: "text", text: "Checking" },
      { type: "tool_use", id: "t1-r2", name: "lookup", input: {} },
    ]);
  });

  it("replays interleaved blocks in order and legacy thinkingBlocks", async () => {
    const interleaved = [
      { type: "thinking", thinking: "a", signature: "s1" },
      { type: "text", text: "Looking" },
      { type: "thinking", thinking: "b", signature: "s2" },
      { type: "tool_use", id: "t1", name: "lookup", input: {} },
    ];
    const calls = stubFetch((n) =>
      n === 1 ? claudeReply(interleaved, "tool_use") : claudeReply(),
    );
    const first = await anthropic().complete(request());
    const turns = (providerMetadata: unknown): Turn[] => [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: first.content,
        toolCalls: first.toolCalls,
        providerMetadata: providerMetadata as never,
      },
    ];
    await anthropic().complete(request(turns(first.providerMetadata)));
    await anthropic().complete(
      request(
        turns({
          provider: "anthropic",
          data: { thinkingBlocks: [interleaved[0], interleaved[2]] },
        }),
      ),
    );
    const sent = (n: number) =>
      (calls[n]?.body["messages"] as { content: unknown[] }[])[1]?.content;
    expect(sent(1)).toEqual(interleaved);
    expect(sent(2)).toEqual([
      interleaved[0],
      interleaved[2],
      interleaved[1],
      interleaved[3],
    ]);
  });

  it("rejects metadata from another provider", async () => {
    stubFetch(() => claudeReply());
    await expect(
      anthropic().complete(
        request([
          {
            role: "assistant",
            content: "x",
            toolCalls: [],
            providerMetadata: { provider: "openai", data: {} },
          },
        ]),
      ),
    ).rejects.toThrow("mismatch");
  });

  it("applies base URL, headers and reports usage", async () => {
    const calls = stubFetch(() => claudeReply());
    const result = await createProvider({
      provider: "anthropic",
      apiKey: "k",
      baseUrl: "https://gw.example.com",
      headers: { "x-team": "yada" },
    }).complete(request());
    expect(calls[0]?.url).toBe("https://gw.example.com/v1/messages");
    expect(calls[0]?.headers.get("x-team")).toBe("yada");
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it("retries 503 and stops retrying when aborted", async () => {
    const attempts = stubFetch(() => json({ error: { message: "busy" } }, 503));
    const make = () =>
      createProvider({ provider: "anthropic", apiKey: "k", maxRetries: 1 });
    await expect(make().complete(request())).rejects.toThrow();
    expect(attempts).toHaveLength(2);
    const controller = new AbortController();
    const aborted = stubFetch(() => {
      controller.abort();
      return json({ error: { message: "busy" } }, 503);
    });
    await expect(
      make().complete({ ...request(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(aborted).toHaveLength(1);
  });
});

describe("openai-compatible", () => {
  it("sends tool calls as JSON strings and degrades tool images", async () => {
    const calls = stubFetch(() => chatReply());
    await openai().complete(
      request([
        { role: "user", content: [{ type: "text", text: "see" }, image] },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "lookup", args: { id: "a" } }],
        },
        {
          role: "tool",
          toolCallId: "c1",
          name: "lookup",
          content: [{ type: "text", text: "shot" }, image],
        },
      ]),
    );
    expect(calls[0]?.body["messages"]).toEqual([
      { role: "system", content: "Help" },
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "lookup", arguments: '{"id":"a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "shot\n[image: image/png]" },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      },
    ]);
    expect(calls[0]?.body["tools"]).toMatchObject([
      { type: "function", function: { name: "lookup" } },
    ]);
  });

  it.each([
    ["stop", "stop"],
    ["tool_calls", "tool_calls"],
    ["length", "length"],
    ["content_filter", "refusal"],
  ])("maps finish reason %s to %s", async (reason, expected) => {
    stubFetch(() => chatReply({ content: "x" }, reason));
    expect((await openai().complete(request())).finishReason).toBe(expected);
  });

  it("maps a refusal and ignores truncated tool calls on length", async () => {
    stubFetch(() => chatReply({ content: null, refusal: "No" }, "stop"));
    expect((await openai().complete(request())).finishReason).toBe("refusal");
    stubFetch(() =>
      chatReply(
        {
          content: "x",
          tool_calls: [
            {
              id: "c",
              type: "function",
              function: { name: "lookup", arguments: '{"id":' },
            },
          ],
        },
        "length",
      ),
    );
    expect(await openai().complete(request())).toMatchObject({
      finishReason: "length",
      toolCalls: [],
    });
  });

  it("reports tool_calls when finish_reason is stop with tool calls", async () => {
    stubFetch(() =>
      chatReply(
        {
          content: null,
          tool_calls: [
            {
              id: "c",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        "stop",
      ),
    );
    expect(await openai().complete(request())).toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [{ id: "c" }],
    });
  });

  it("replays an empty assistant turn as empty text", async () => {
    const calls = stubFetch(() => chatReply());
    await openai().complete(
      request([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "", toolCalls: [] },
        { role: "user", content: "Again" },
      ]),
    );
    expect(calls[0]?.body["messages"]).toContainEqual({
      role: "assistant",
      content: "",
    });
  });

  it("throws on invalid tool call arguments", async () => {
    stubFetch(() =>
      chatReply(
        {
          content: null,
          tool_calls: [
            {
              id: "c",
              type: "function",
              function: { name: "lookup", arguments: "not-json" },
            },
          ],
        },
        "tool_calls",
      ),
    );
    await expect(openai().complete(request())).rejects.toThrow("Invalid model");
  });

  it("sends the deepseek thinking switch and max_tokens to compatible servers", async () => {
    const calls = stubFetch(() => chatReply());
    await createProvider({ provider: "deepseek", apiKey: "k" }).complete(
      request(),
    );
    await createProvider({
      provider: "ollama",
      model: "m",
      maxTokens: 50,
      temperature: 0.5,
    }).complete(request());
    expect(calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0]?.body).toMatchObject({ thinking: { type: "disabled" } });
    expect(calls[1]?.body).toMatchObject({ max_tokens: 50, temperature: 0.5 });
    expect(calls[1]?.body).not.toHaveProperty("thinking");
  });

  it("retries 503 and stops retrying when aborted", async () => {
    const calls = stubFetch(() => json({ error: { message: "busy" } }, 503));
    const make = () =>
      createProvider({
        provider: "openai-compatible",
        model: "m",
        baseUrl: "http://localhost:1/v1",
        maxRetries: 1,
      });
    await expect(make().complete(request())).rejects.toThrow();
    expect(calls).toHaveLength(2);
    const controller = new AbortController();
    const aborted = stubFetch(() => {
      controller.abort();
      return json({ error: { message: "busy" } }, 503);
    });
    await expect(
      make().complete({ ...request(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(aborted).toHaveLength(1);
  });

  it("sends stream options when streaming and rejects empty streams", async () => {
    const calls = stubFetch(
      () =>
        new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const stream = openai().stream?.(request());
    await expect(stream?.next()).rejects.toThrow("Empty model stream");
    expect(calls[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });
});
