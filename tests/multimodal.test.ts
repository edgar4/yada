import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessageChunk } from "@langchain/core/messages";
import {
  contentText,
  contextWindow,
  createProvider,
  createFakeProvider,
  readTool,
  run,
} from "../src/index.js";
import type { Content, ProviderResult, Turn } from "../src/index.js";
import { checkpointSchema } from "../src/core/checkpoint.js";
import { maxImageChars } from "../src/core/content.js";
import { readResult } from "../src/connectors/mcp/rpc.js";
import { jobInputSchema } from "../src/service/contracts.js";
import { chatReply, claudeReply, stubFetch } from "./helpers/http.js";
import { storageFixture } from "./helpers/storage.js";
import { createHandler } from "../src/service/http.js";
const identity = { actorId: "a", tenantId: "t" };
const image = (data = "aGVsbG8=") =>
  ({ type: "image", mimeType: "image/png", data }) as const;
const answer: ProviderResult = {
  content: "Done",
  toolCalls: [],
  finishReason: "stop",
};
const base = (provider: ReturnType<typeof createFakeProvider>) => ({
  provider,
  identity,
  system: "Help",
  signal: new AbortController().signal,
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("content schema", () => {
  const turns = (content: Content): unknown => ({
    version: 1,
    messages: [{ role: "user", content }],
    pending: [],
    rounds: 0,
    calls: 0,
  });
  it("round trips parts and accepts string content", () => {
    const parts = [{ type: "text", text: "see" }, image()] as Content;
    for (const content of ["old", parts])
      expect(
        checkpointSchema.parse(JSON.parse(JSON.stringify(turns(content))))
          .messages[0],
      ).toEqual({ role: "user", content });
  });
  it.each([
    ["too many images", [image(), image(), image(), image(), image()]],
    ["oversized image", [image("A".repeat(maxImageChars + 4))]],
    ["bad mime", [{ ...image(), mimeType: "image/svg+xml" }]],
    ["bad base64", [image("not base64!")]],
  ])("rejects %s", (_name, content) => {
    expect(checkpointSchema.safeParse(turns(content as Content)).success).toBe(
      false,
    );
  });
  it("accepts four images", () => {
    expect(
      checkpointSchema.safeParse(turns([image(), image(), image(), image()]))
        .success,
    ).toBe(true);
  });
  it("limits job input text", () => {
    const input = (value: unknown) =>
      jobInputSchema.safeParse({ id: "a", profileId: "p", input: value })
        .success;
    expect(input([{ type: "text", text: "hi" }, image()])).toBe(true);
    expect(input([])).toBe(false);
    expect(input([{ type: "text", text: "x".repeat(32_001) }])).toBe(false);
  });
});
describe("providers", () => {
  const request = {
    system: "S",
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, image()] },
    ] as Turn[],
    tools: [],
    signal: new AbortController().signal,
  };
  const reply = new AIMessageChunk({
    content: "ok",
    response_metadata: { finishReason: "STOP" },
  });
  const png = "data:image/png;base64,aGVsbG8=";
  it("maps images for anthropic", async () => {
    const calls = stubFetch(() => claudeReply());
    const adapter = createProvider({ provider: "anthropic", apiKey: "key" });
    expect(adapter.capabilities.vision).toBe(true);
    await adapter.complete(request);
    expect(calls[0]?.body["messages"]).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
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
    ]);
  });
  it("maps images for openai", async () => {
    const calls = stubFetch(() => chatReply());
    const adapter = createProvider({ provider: "openai", apiKey: "key" });
    expect(adapter.capabilities.vision).toBe(true);
    await adapter.complete(request);
    expect((calls[0]?.body["messages"] as unknown[])[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: png } },
      ],
    });
  });
  it("maps images for gemini", async () => {
    const invoke = vi
      .spyOn(
        ChatGoogleGenerativeAI.prototype as unknown as {
          invoke: (messages: unknown) => unknown;
        },
        "invoke",
      )
      .mockResolvedValue(reply);
    const adapter = createProvider({ provider: "gemini", apiKey: "key" });
    expect(adapter.capabilities.vision).toBe(true);
    await adapter.complete(request);
    expect(
      (invoke.mock.calls[0]?.[0] as { content: unknown }[] | undefined)?.[1]
        ?.content,
    ).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: png } },
    ]);
  });
  it("sends tool images in a following user message", async () => {
    const calls = stubFetch(() => chatReply());
    await createProvider({ provider: "openai", apiKey: "key" }).complete({
      ...request,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "1", name: "shot", args: {} }],
        },
        {
          role: "tool",
          toolCallId: "1",
          name: "shot",
          content: [{ type: "text", text: "taken" }, image()],
        },
      ],
    });
    const messages = calls[0]?.body["messages"] as { content: unknown }[];
    expect(messages.at(-2)?.content).toBe("taken\n[image: image/png]");
    expect(messages.at(-1)?.content).toEqual([
      { type: "image_url", image_url: { url: png } },
    ]);
  });
  it("defaults vision off for deepseek and local, on by option", () => {
    expect(
      createProvider({ provider: "deepseek", apiKey: "key" }).capabilities
        .vision,
    ).toBe(false);
    const local = (vision?: boolean) =>
      createProvider({
        provider: "ollama",
        model: "llava",
        ...(vision === undefined ? {} : { vision }),
      }).capabilities.vision;
    expect(local()).toBe(false);
    expect(local(true)).toBe(true);
  });
});
describe("runtime", () => {
  const shot = (content: Content) =>
    readTool({
      name: "shot",
      description: "Shot",
      input: z.strictObject({}),
      authorize: () => Promise.resolve(true),
      execute: () => Promise.resolve(content),
    });
  const script = (_request: unknown, call: number) =>
    call === 1
      ? ({
          content: "",
          toolCalls: [{ id: "1", name: "shot", args: {} }],
          finishReason: "tool_calls",
        } satisfies ProviderResult)
      : answer;
  it("fails with unsupported when the provider lacks vision", async () => {
    const provider = createFakeProvider(() => answer);
    const result = await run({
      ...base({ ...provider, capabilities: { toolCalling: true } }),
      tools: [],
      input: [image()],
    });
    expect(result).toEqual({ status: "failed", code: "unsupported" });
    expect(provider.requests).toHaveLength(0);
  });
  it("passes tool image parts to vision providers, applying hooks and truncation", async () => {
    const provider = createFakeProvider(script);
    const events: string[] = [];
    await run({
      ...base(provider),
      tools: [
        shot([{ type: "text", text: "secret " + "x".repeat(50) }, image()]),
      ],
      input: [{ type: "text", text: "go" }, image()],
      limits: { maxToolOutput: 20 },
      hooks: {
        afterTool: (_call, text) => text.replace("secret", "redacted"),
        onEvent: (event) => {
          if (event.type === "tool_finished") events.push(event.content);
          return undefined;
        },
      },
    });
    const tool = provider.requests[1]?.messages.at(-1);
    expect(tool?.content).toEqual([
      { type: "text", text: `redacted ${"x".repeat(11)}…[truncated 39 chars]` },
      image(),
    ]);
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events[0]).not.toContain("aGVsbG8=");
    expect(events[0]).toContain("[image: image/png]");
  });
  it("degrades tool images to text for providers without vision", async () => {
    const provider = createFakeProvider(script);
    const result = await run({
      ...base({ ...provider, capabilities: { toolCalling: true } }),
      tools: [shot([image()])],
      input: "go",
    });
    expect(result.status).toBe("completed");
    expect(provider.requests[1]?.messages.at(-1)?.content).toBe(
      "[image: image/png]",
    );
  });
  it("compacts image tool results and measures them by length", () => {
    const history: Turn[] = [
      { role: "user", content: "a" },
      {
        role: "tool",
        toolCallId: "1",
        name: "shot",
        content: [image("A".repeat(400))],
      },
      { role: "user", content: "b" },
    ];
    const windowed = contextWindow(history, 10_000, 100);
    expect(windowed[1]?.content).toMatch(/^\[compacted: \d+ chars\]$/);
    expect(contextWindow(history, 200)).toEqual(history.slice(2));
  });
});
describe("mcp images", () => {
  const result = (data: string, mimeType = "image/png") => ({
    content: [
      { type: "text" as const, text: "caption" },
      { type: "image" as const, data, mimeType },
    ],
  });
  it("turns images into parts", () => {
    expect(readResult(result("aGVsbG8="))).toEqual([
      { type: "text", text: "caption" },
      image(),
    ]);
  });
  it("keeps placeholders for oversized, unsupported or excess images", () => {
    expect(readResult(result("A".repeat(maxImageChars + 4)))).toBe(
      "caption\n[image: image/png]",
    );
    expect(readResult(result("aGVsbG8=", "image/svg+xml"))).toBe(
      "caption\n[image: image/svg+xml]",
    );
    const many = readResult({
      content: Array.from({ length: 5 }, () => ({
        type: "image" as const,
        data: "aGVsbG8=",
        mimeType: "image/png",
      })),
    }) as Exclude<Content, string>;
    expect(many.filter((part) => part.type === "image")).toHaveLength(4);
    expect(contentText(many).endsWith("[image: image/png]")).toBe(true);
  });
});
describe("http", () => {
  it("accepts parts, stores them and returns text history", async () => {
    const s = await storageFixture("sqlite");
    const handler = createHandler({
      storage: s.storage,
      origins: [],
      authenticate: () => Promise.resolve(s.identity),
      authorizeProfile: () => Promise.resolve(true),
    });
    const input = [{ type: "text", text: "look" }, image("A".repeat(200_000))];
    const post = () =>
      handler(
        new Request("http://localhost/v1/conversations/c/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "r1", profileId: "p", input }),
        }),
      );
    const first = await post();
    expect(first.status).toBe(202);
    expect(((await first.json()) as { input: unknown }).input).toEqual(input);
    expect((await post()).status).toBe(202);
  });
});
