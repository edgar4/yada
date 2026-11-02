import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider, providerConfigFromEnv } from "../src/index.js";
import type { ProviderRequest, Turn } from "../src/index.js";
import {
  chatReply,
  responsesReply,
  responsesStream,
  stubFetch,
} from "./helpers/http.js";
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
const openai = (extra: object = {}) =>
  createProvider({ provider: "openai", apiKey: "k", model: "m", ...extra });
const call = {
  type: "function_call",
  id: "fc_1",
  call_id: "c1",
  name: "lookup",
  arguments: '{"id":"a"}',
  status: "completed",
};
const reasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  encrypted_content: "enc",
};
const message = (part: object) => ({
  type: "message",
  id: "m",
  role: "assistant",
  status: "completed",
  content: [part],
});

describe("openai responses", () => {
  it("sends the documented request shape", async () => {
    const calls = stubFetch(() => responsesReply());
    await openai({ effort: "high", maxTokens: 100 }).complete(
      request([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello", toolCalls: [] },
      ]),
    );
    expect(calls[0]?.url).toMatch(/\/responses$/);
    expect(calls[0]?.body).toEqual({
      model: "m",
      instructions: "Help",
      input: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
          },
          strict: false,
        },
      ],
      max_output_tokens: 100,
      reasoning: { effort: "high" },
    });
  });

  it("defaults the hosted model to no reasoning", async () => {
    const calls = stubFetch(() => responsesReply());
    await createProvider({ provider: "openai", apiKey: "k" }).complete(
      request(),
    );
    expect(calls[0]?.body).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
    });
  });

  it("round trips a tool call and replays reasoning on round two", async () => {
    const calls = stubFetch((n) =>
      responsesReply(n === 1 ? [reasoning, call] : undefined),
    );
    const provider = openai();
    const first = await provider.complete(request());
    expect(first).toMatchObject({
      content: "",
      toolCalls: [{ id: "c1", name: "lookup", args: { id: "a" } }],
      finishReason: "tool_calls",
      providerMetadata: {
        provider: "openai",
        data: { api: "responses", reasoning: [reasoning] },
      },
    });
    await provider.complete(
      request([
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: first.toolCalls,
          ...(first.providerMetadata && {
            providerMetadata: first.providerMetadata,
          }),
        },
        { role: "tool", toolCallId: "c1", name: "lookup", content: "found" },
      ]),
    );
    expect(calls[1]?.body["input"]).toEqual([
      { role: "user", content: "Hi" },
      reasoning,
      {
        type: "function_call",
        call_id: "c1",
        name: "lookup",
        arguments: '{"id":"a"}',
      },
      { type: "function_call_output", call_id: "c1", output: "found" },
    ]);
  });

  it("maps images to input items", async () => {
    const calls = stubFetch(() => responsesReply());
    const image = {
      type: "image",
      mimeType: "image/png",
      data: "aGVsbG8=",
    } as const;
    await openai().complete(
      request([
        { role: "user", content: [{ type: "text", text: "see" }, image] },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "lookup", args: {} }],
        },
        { role: "tool", toolCallId: "c1", name: "lookup", content: [image] },
      ]),
    );
    const url = "data:image/png;base64,aGVsbG8=";
    const input = [{ type: "input_image", detail: "auto", image_url: url }];
    expect(calls[0]?.body["input"]).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "see" }, ...input],
      },
      {
        type: "function_call",
        call_id: "c1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "c1",
        output: "[image: image/png]",
      },
      { role: "user", content: input },
    ]);
  });

  it.each([
    ["foreign provider", { provider: "anthropic", data: {} }],
    ["chat metadata", { provider: "openai", data: {} }],
  ])("rejects metadata from %s", async (_name, providerMetadata) => {
    stubFetch(() => responsesReply());
    await expect(
      openai().complete(
        request([
          { role: "assistant", content: "x", toolCalls: [], providerMetadata },
        ]),
      ),
    ).rejects.toThrow("mismatch");
  });

  it("rejects responses metadata in chat mode", async () => {
    stubFetch(() => chatReply());
    await expect(
      openai({ api: "chat" }).complete(
        request([
          {
            role: "assistant",
            content: "x",
            toolCalls: [],
            providerMetadata: {
              provider: "openai",
              data: { api: "responses" },
            },
          },
        ]),
      ),
    ).rejects.toThrow("mismatch");
  });

  it.each([
    [
      "max_output_tokens",
      [message({ type: "output_text", text: "cut", annotations: [] }), call],
      "length",
    ],
    ["content_filter", [], "refusal"],
  ])("maps incomplete %s", async (reason, output, finishReason) => {
    stubFetch(() =>
      responsesReply(output, {
        status: "incomplete",
        incomplete_details: { reason },
      }),
    );
    expect(await openai().complete(request())).toMatchObject({
      finishReason,
      toolCalls: [],
    });
  });

  it("maps refusal parts and failed responses", async () => {
    stubFetch((n) =>
      n === 1
        ? responsesReply([message({ type: "refusal", refusal: "no" })])
        : responsesReply([], { status: "failed", error: { message: "boom" } }),
    );
    expect(await openai().complete(request())).toMatchObject({
      finishReason: "refusal",
    });
    await expect(openai().complete(request())).rejects.toThrow("boom");
  });

  it("maps usage including cached tokens", async () => {
    stubFetch(() => responsesReply());
    expect((await openai().complete(request())).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 4,
    });
  });

  it("streams text deltas into the same result", async () => {
    const calls = stubFetch(() =>
      responsesStream(["a", "b"], [reasoning, call]),
    );
    const stream = openai().stream?.(request());
    if (!stream) throw new Error("Missing stream");
    const deltas: string[] = [];
    let next = await stream.next();
    while (!next.done) {
      deltas.push(next.value.delta);
      next = await stream.next();
    }
    expect(deltas).toEqual(["a", "b"]);
    expect(calls[0]?.body["stream"]).toBe(true);
    expect(next.value).toMatchObject({
      toolCalls: [{ id: "c1" }],
      finishReason: "tool_calls",
      providerMetadata: { data: { reasoning: [reasoning] } },
    });
  });

  it("rejects an empty stream", async () => {
    stubFetch(
      () =>
        new Response("", { headers: { "content-type": "text/event-stream" } }),
    );
    await expect(openai().stream?.(request()).next()).rejects.toThrow("Empty");
  });

  it("selects the API from config and the environment", async () => {
    const calls = stubFetch((n) => (n === 2 ? responsesReply() : chatReply()));
    const local = {
      provider: "openai-compatible",
      model: "m",
      baseUrl: "http://localhost:1/v1",
    } as const;
    await createProvider(local).complete(request());
    await createProvider({ ...local, api: "responses" }).complete(request());
    await createProvider(
      providerConfigFromEnv({
        YADA_LLM_PROVIDER: "openai",
        YADA_LLM_API_KEY: "k",
        YADA_LLM_OPENAI_API: "chat",
      }),
    ).complete(request());
    expect(
      calls.map((c) =>
        c.url.replace(/^.*\/(chat\/completions|responses)$/, "$1"),
      ),
    ).toEqual(["chat/completions", "responses", "chat/completions"]);
  });
});
