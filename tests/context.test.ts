import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  contextWindow,
  createFakeProvider,
  createStorage,
  readTool,
  run,
  runConversation,
} from "../src/index.js";
import type { ConversationStore, ProviderResult, Turn } from "../src/index.js";
const identity = { actorId: "a", tenantId: "t" };
const answer: ProviderResult = {
  content: "Done",
  toolCalls: [],
  finishReason: "stop",
};
const call = (id: string): ProviderResult => ({
  content: "",
  toolCalls: [{ id, name: "lookup", args: {} }],
  providerMetadata: { provider: "x", data: { thinking: id } },
  finishReason: "tool_calls",
});
const lookup = readTool({
  name: "lookup",
  description: "Lookup",
  input: z.strictObject({}),
  authorize: () => Promise.resolve(true),
  execute: () => Promise.resolve("x".repeat(500)),
});
const storage = () =>
  createStorage({
    driver: "sqlite",
    filename: ":memory:",
    encryptionKey: "ab".repeat(32),
  });
const base = {
  tools: [lookup],
  identity,
  system: "Help",
  signal: AbortSignal.timeout(5000),
};
describe("in-run compaction", () => {
  const script = [call("1"), call("2"), answer];
  const make = () =>
    createFakeProvider((_request, n) => script[n - 1] ?? answer);
  it("compacts old tool results instead of failing", async () => {
    const provider = make();
    const result = await run({
      ...base,
      provider,
      input: "Go",
      limits: { maxContextChars: 1600 },
    });
    expect(result).toEqual({ status: "completed", text: "Done" });
    const last = provider.requests[2]?.messages ?? [];
    expect(last.filter((turn) => turn.role === "tool")).toMatchObject([
      { content: "[compacted: 500 chars]" },
      { content: "x".repeat(500) },
    ]);
  });
  it("fails with limit when compaction is not enough", async () => {
    expect(
      await run({
        ...base,
        provider: make(),
        input: "Go",
        limits: { maxContextChars: 900 },
      }),
    ).toEqual({ status: "failed", code: "limit" });
  });
});
describe("contextWindow", () => {
  const history: Turn[] = [
    { role: "user", content: "one" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "t", args: {} }],
    },
    { role: "tool", toolCallId: "1", name: "t", content: "a".repeat(100) },
    { role: "assistant", content: "A", toolCalls: [] },
    { role: "user", content: "two" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "2", name: "t", args: {} }],
    },
    { role: "tool", toolCallId: "2", name: "t", content: "b".repeat(100) },
    { role: "assistant", content: "B", toolCalls: [] },
  ];
  it("compacts older tool results beyond the budget and keeps pairs", () => {
    const window = contextWindow(history, 10_000, 150);
    expect(window).toHaveLength(8);
    expect(window[2]).toMatchObject({ content: "[compacted: 100 chars]" });
    expect(window[6]).toMatchObject({ content: "b".repeat(100) });
  });
  it("starts at a user turn", () => {
    expect(contextWindow(history, 400, 150)[0]).toEqual({
      role: "user",
      content: "two",
    });
  });
});
describe("conversation history", () => {
  it("keeps tool turns and provider metadata across turns", async () => {
    const s = await storage();
    try {
      const script = [call("1"), answer, answer];
      const provider = createFakeProvider((_r, n) => script[n - 1] ?? answer);
      const options = {
        ...base,
        provider,
        conversationId: "c",
        store: s.conversations,
      };
      await runConversation({ ...options, input: "First" });
      await runConversation({ ...options, input: "Second" });
      const second = provider.requests[2]?.messages ?? [];
      expect(second.map((turn) => turn.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
        "user",
      ]);
      expect(second[1]).toMatchObject({
        providerMetadata: { data: { thinking: "1" } },
      });
      expect(second[2]).toMatchObject({ content: "x".repeat(500) });
    } finally {
      await s.close();
    }
  });
  it("loads legacy text-only messages", async () => {
    const s = await storage();
    try {
      await s.conversations.save(
        identity,
        "old",
        [
          { role: "user", content: "hi" },
          { role: "assistant", content: "yo" },
        ] as never,
        0,
      );
      expect(
        (await s.conversations.load(identity, "old"))?.messages[1],
      ).toEqual({
        role: "assistant",
        content: "yo",
        toolCalls: [],
      });
    } finally {
      await s.close();
    }
  });
  it("persists failed turns with a marker the model never sees", async () => {
    const s = await storage();
    try {
      const provider = createFakeProvider(() => answer);
      const options = {
        ...base,
        provider,
        conversationId: "f",
        store: s.conversations,
      };
      await runConversation({
        ...options,
        input: "Lost",
        signal: AbortSignal.abort(),
      });
      expect((await s.conversations.load(identity, "f"))?.messages).toEqual([
        { role: "user", content: "Lost" },
        { role: "failure", code: "cancelled" },
      ]);
      await runConversation({ ...options, input: "Next" });
      expect(provider.requests[0]?.messages).toEqual([
        { role: "user", content: "Lost" },
        { role: "user", content: "Next" },
      ]);
    } finally {
      await s.close();
    }
  });
  it("retries the save once on conflict by appending to the latest messages", async () => {
    const s = await storage();
    try {
      const store: ConversationStore = {
        load: (...args) => s.conversations.load(...args),
        save: async (id, key, messages, revision) => {
          if (revision === 0)
            await s.conversations.save(
              id,
              key,
              [{ role: "user", content: "other" }],
              0,
            );
          return s.conversations.save(id, key, messages, revision);
        },
      };
      await runConversation({
        ...base,
        provider: createFakeProvider(() => answer),
        tools: [],
        conversationId: "x",
        store,
        input: "Mine",
      });
      expect(
        (await s.conversations.load(identity, "x"))?.messages.map((message) =>
          "content" in message ? message.content : "",
        ),
      ).toEqual(["other", "Mine", "Done"]);
    } finally {
      await s.close();
    }
  });
});
