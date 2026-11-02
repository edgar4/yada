import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createProvider,
  providerConfigFromEnv,
  readTool,
  run,
} from "../src/index.js";
import type { ProviderRequest, Turn } from "../src/index.js";
import { json, stubFetch } from "./helpers/http.js";
afterEach(() => vi.unstubAllGlobals());
const reply = (
  parts: object[] = [{ text: "ok" }],
  extra: object = { finishReason: "STOP" },
) =>
  json({
    candidates: [{ index: 0, content: { role: "model", parts }, ...extra }],
  });
const request = (messages: Turn[] = [{ role: "user", content: "Hi" }]) =>
  ({
    system: "Help",
    messages,
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    ],
    signal: AbortSignal.timeout(5000),
  }) satisfies ProviderRequest;
const gemini = (extra: object = {}) =>
  createProvider({ provider: "gemini", apiKey: "key", ...extra });
const png = { type: "image", mimeType: "image/png", data: "aGVsbG8=" } as const;

describe("request mapping", () => {
  it.each([undefined, "custom-model"])("selects model %s", async (model) => {
    const calls = stubFetch(() => reply());
    expect(await gemini(model ? { model } : {}).complete(request())).toEqual({
      content: "ok",
      toolCalls: [],
      finishReason: "stop",
    });
    expect(calls[0]?.url).toContain(
      `models/${model ?? "gemini-3.8-flash"}:generateContent`,
    );
  });

  it("sends system, tools, content parts, limits, headers and base URL", async () => {
    const calls = stubFetch(() => reply());
    await gemini({
      baseUrl: "https://proxy.example.com/gemini",
      headers: { "x-team": "a" },
      temperature: 0.5,
      maxTokens: 100,
    }).complete(
      request([
        { role: "user", content: [{ type: "text", text: "look" }, png] },
        {
          role: "assistant",
          content: "Checking",
          toolCalls: [
            { id: "call_a", name: "lookup", args: { id: "a" } },
            { id: "call_b", name: "lookup", args: { id: "b" } },
          ],
        },
        { role: "tool", toolCallId: "call_a", name: "lookup", content: "A" },
        {
          role: "tool",
          toolCallId: "call_b",
          name: "lookup",
          content: [{ type: "text", text: "B" }, png],
        },
        { role: "user", content: "Thanks" },
      ]),
    );
    const call = calls[0];
    expect(call?.url).toMatch(/^https:\/\/proxy\.example\.com\/gemini\//);
    expect(call?.headers.get("x-team")).toBe("a");
    expect(call?.headers.get("x-goog-api-key")).toBe("key");
    expect(call?.body).toEqual({
      systemInstruction: { role: "user", parts: [{ text: "Help" }] },
      generationConfig: { maxOutputTokens: 100, temperature: 0.5 },
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              description: "Lookup",
              parametersJsonSchema: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
          ],
        },
      ],
      contents: [
        {
          role: "user",
          parts: [
            { text: "look" },
            { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
          ],
        },
        {
          role: "model",
          parts: [
            { text: "Checking" },
            {
              functionCall: { id: "call_a", name: "lookup", args: { id: "a" } },
            },
            {
              functionCall: { id: "call_b", name: "lookup", args: { id: "b" } },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call_a",
                name: "lookup",
                response: { result: "A" },
              },
            },
            {
              functionResponse: {
                id: "call_b",
                name: "lookup",
                response: { result: "B\n[image: image/png]" },
              },
            },
            { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
            { text: "Thanks" },
          ],
        },
      ],
    });
  });

  it.each([
    ["low", "LOW"],
    ["medium", "MEDIUM"],
    ["high", "HIGH"],
    ["xhigh", "HIGH"],
    ["max", "HIGH"],
  ])("maps effort %s to thinking level %s", async (effort, thinkingLevel) => {
    const calls = stubFetch(() => reply());
    await gemini({ effort }).complete(request());
    expect(calls[0]?.body["generationConfig"]).toMatchObject({
      thinkingConfig: { thinkingLevel },
    });
  });

  it("omits thinking config without effort", async () => {
    const calls = stubFetch(() => reply());
    await gemini().complete(request());
    expect(calls[0]?.body["generationConfig"]).not.toHaveProperty(
      "thinkingConfig",
    );
  });

  it("accepts effort from the environment", () => {
    expect(
      providerConfigFromEnv({
        YADA_LLM_PROVIDER: "gemini",
        YADA_LLM_API_KEY: "key",
        YADA_LLM_EFFORT: "low",
      }),
    ).toMatchObject({ provider: "gemini", effort: "low" });
  });
});

describe("tool calls", () => {
  const lookup = (execute: () => Promise<string>) =>
    readTool({
      name: "lookup",
      description: "Lookup",
      input: z.strictObject({ id: z.string() }),
      authorize: () => Promise.resolve(true),
      execute,
    });
  const loop = (execute: () => Promise<string>) =>
    run({
      provider: gemini(),
      tools: [lookup(execute)],
      identity: { actorId: "a", tenantId: "t" },
      input: "Find a",
      system: "Help",
      signal: AbortSignal.timeout(5000),
    });

  it("generates ids and replays thought signatures on the same call", async () => {
    const calls = stubFetch((call) =>
      call === 1
        ? reply([
            { text: "Looking", thoughtSignature: "s0" },
            {
              functionCall: { name: "lookup", args: { id: "a" } },
              thoughtSignature: "s1",
            },
            { functionCall: { name: "lookup", args: { id: "b" } } },
          ])
        : reply([{ text: "Available" }]),
    );
    const execute = vi.fn(() => Promise.resolve("Available"));
    expect(await loop(execute)).toEqual({
      status: "completed",
      text: "Available",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(calls[1]?.body["contents"]).toEqual([
      { role: "user", parts: [{ text: "Find a" }] },
      {
        role: "model",
        parts: [
          { text: "Looking", thoughtSignature: "s0" },
          {
            functionCall: { name: "lookup", args: { id: "a" } },
            thoughtSignature: "s1",
          },
          { functionCall: { name: "lookup", args: { id: "b" } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "lookup",
              response: { result: "Available" },
            },
          },
          {
            functionResponse: {
              name: "lookup",
              response: { result: "Available" },
            },
          },
        ],
      },
    ]);
  });

  it("keeps ids supplied by Gemini", async () => {
    const calls = stubFetch((call) =>
      call === 1
        ? reply([
            { functionCall: { id: "g1", name: "lookup", args: { id: "a" } } },
          ])
        : reply(),
    );
    await loop(() => Promise.resolve("A"));
    expect(calls[1]?.body["contents"]).toMatchObject([
      {},
      { parts: [{ functionCall: { id: "g1", name: "lookup" } }] },
      { parts: [{ functionResponse: { id: "g1", name: "lookup" } }] },
    ]);
  });

  it("returns generated ids from complete", async () => {
    stubFetch(() =>
      reply([{ functionCall: { name: "lookup", args: { id: "a" } } }]),
    );
    const result = await gemini().complete(request());
    expect(result.toolCalls).toEqual([
      { id: "gemini_call_0", name: "lookup", args: { id: "a" } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result).not.toHaveProperty("providerMetadata");
  });
});

describe("results", () => {
  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["SAFETY", "refusal"],
    ["PROHIBITED_CONTENT", "refusal"],
    ["RECITATION", "refusal"],
    ["OTHER", "other"],
  ])("maps finish reason %s to %s", async (finishReason, expected) => {
    stubFetch(() => reply([{ text: "Partial" }], { finishReason }));
    expect((await gemini().complete(request())).finishReason).toBe(expected);
  });

  it("drops tool calls cut off by the token limit", async () => {
    stubFetch(() =>
      reply([{ functionCall: { name: "lookup", args: {} } }], {
        finishReason: "MAX_TOKENS",
      }),
    );
    const result = await gemini().complete(request());
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("length");
  });

  it("treats a blocked prompt as a refusal", async () => {
    stubFetch(() => json({ promptFeedback: { blockReason: "SAFETY" } }));
    expect((await gemini().complete(request())).finishReason).toBe("refusal");
  });

  it("maps usage with cached and thinking tokens", async () => {
    stubFetch(() =>
      json({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 40,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 7,
        },
      }),
    );
    expect((await gemini().complete(request())).usage).toEqual({
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 40,
    });
  });

  it("excludes thought text from content", async () => {
    stubFetch(() =>
      reply([{ text: "hmm", thought: true }, { text: "Answer" }]),
    );
    expect((await gemini().complete(request())).content).toBe("Answer");
  });
});

describe("streaming", () => {
  const sse = (...events: object[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  const chunk = (parts: object[], extra: object = {}) => ({
    candidates: [{ index: 0, content: { role: "model", parts }, ...extra }],
  });

  it("yields deltas and aggregates parts, signatures, finish and usage", async () => {
    const calls = stubFetch(() =>
      sse(chunk([{ text: "Hel" }]), chunk([{ text: "lo" }]), {
        ...chunk(
          [
            {
              functionCall: { name: "lookup", args: { id: "a" } },
              thoughtSignature: "sig",
            },
          ],
          { finishReason: "STOP" },
        ),
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      }),
    );
    const stream = gemini().stream?.(request());
    if (!stream) throw new Error("Missing stream");
    const deltas: string[] = [];
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        expect(next.value).toEqual({
          content: "Hello",
          toolCalls: [
            { id: "gemini_call_1", name: "lookup", args: { id: "a" } },
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 3, outputTokens: 2 },
          providerMetadata: {
            provider: "gemini",
            data: {
              parts: [
                { text: "Hello" },
                {
                  functionCall: { name: "lookup", args: { id: "a" } },
                  thoughtSignature: "sig",
                },
              ],
            },
          },
        });
        break;
      }
      deltas.push(next.value.delta);
    }
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(calls[0]?.url).toContain("streamGenerateContent");
  });

  it("fails on an empty stream", async () => {
    stubFetch(() => sse());
    await expect(gemini().stream?.(request()).next()).rejects.toThrow();
  });
});

describe("errors", () => {
  it("retries transient failures with the SDK", async () => {
    const calls = stubFetch((call) =>
      call === 1
        ? json(
            { error: { code: 503, status: "UNAVAILABLE", message: "x" } },
            503,
          )
        : reply(),
    );
    expect((await gemini({ maxRetries: 1 }).complete(request())).content).toBe(
      "ok",
    );
    expect(calls).toHaveLength(2);
  }, 15000);

  it("does not retry with maxRetries 0", async () => {
    const calls = stubFetch(() =>
      json({ error: { code: 503, status: "UNAVAILABLE", message: "x" } }, 503),
    );
    await expect(
      gemini({ maxRetries: 0 }).complete(request()),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("rejects metadata belonging to another provider", async () => {
    await expect(
      gemini().complete(
        request([
          {
            role: "assistant",
            content: "",
            toolCalls: [],
            providerMetadata: { provider: "anthropic", data: {} },
          },
        ]),
      ),
    ).rejects.toThrow("Provider metadata mismatch");
  });

  describe("server tools", () => {
    const code = { executableCode: { language: "PYTHON", code: "print(1)" } };
    const output = {
      codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" },
    };
    const grounding = {
      webSearchQueries: ["yada"],
      groundingChunks: [
        { web: { uri: "https://a.example", title: "A" } },
        { web: { uri: "https://a.example", title: "A again" } },
        { web: { uri: "https://b.example", title: "B" } },
      ],
    };
    const withTools = () =>
      gemini({ serverTools: ["web_search", "code_execution"] });

    it("declares tools and normalizes sources and call counts", async () => {
      const calls = stubFetch(() =>
        reply([code, output, { text: "Answer" }], {
          finishReason: "STOP",
          groundingMetadata: grounding,
        }),
      );
      const result = await withTools().complete(request());
      expect((calls[0]?.body["tools"] as object[]).slice(1)).toEqual([
        { googleSearch: {} },
        { codeExecution: {} },
      ]);
      expect(calls[0]?.body["tools"]).toHaveLength(3);
      expect(result).toMatchObject({
        content: "Answer",
        toolCalls: [],
        finishReason: "stop",
        usage: { serverToolCalls: 2 },
        providerMetadata: {
          provider: "gemini",
          data: {
            parts: [code, output, { text: "Answer" }],
            sources: [
              { url: "https://a.example", title: "A" },
              { url: "https://b.example", title: "B" },
            ],
          },
        },
      });
    });

    it("replays code execution parts", async () => {
      const calls = stubFetch((n) =>
        n === 1 ? reply([code, output, { text: "Answer" }]) : reply(),
      );
      const first = await withTools().complete(request());
      await withTools().complete(
        request([
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: first.content,
            toolCalls: [],
            ...(first.providerMetadata && {
              providerMetadata: first.providerMetadata,
            }),
          },
          { role: "user", content: "More" },
        ]),
      );
      expect(
        (calls[1]?.body["contents"] as { parts: object[] }[])[1]?.parts,
      ).toEqual([code, output, { text: "Answer" }]);
    });

    it("does not count toward tool-call limits", async () => {
      const calls = stubFetch((n) =>
        n === 1
          ? reply(
              [
                code,
                output,
                { functionCall: { name: "lookup", args: { id: "a" } } },
              ],
              {
                finishReason: "STOP",
                groundingMetadata: grounding,
              },
            )
          : reply([{ text: "Done" }]),
      );
      const execute = vi.fn(() => Promise.resolve("A"));
      const result = await run({
        provider: withTools(),
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
        input: "Find",
        system: "Help",
        limits: { maxToolCalls: 1 },
        signal: AbortSignal.timeout(5000),
      });
      expect(result).toEqual({ status: "completed", text: "Done" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
    });
  });
});
