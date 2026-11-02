import { expect, it } from "vitest";
import {
  createStorage,
  createFakeProvider,
  runConversation,
} from "../src/index.js";
it("resumes committed messages and does not save failed runs", async () => {
  const store = await createStorage({
    driver: "sqlite",
    filename: ":memory:",
    encryptionKey: "ab".repeat(32),
  });
  try {
    const provider = createFakeProvider(() => ({
      content: "Hello",
      toolCalls: [],
      finishReason: "stop",
    }));
    const options = {
      provider,
      tools: [],
      identity: { actorId: "a", tenantId: "t" },
      system: "Help",
      input: "First",
      signal: AbortSignal.timeout(5000),
      conversationId: "one",
      store: store.conversations,
    };
    await runConversation(options);
    await runConversation({ ...options, input: "Second" });
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Hello", toolCalls: [] },
      { role: "user", content: "Second" },
    ]);
    await runConversation({ ...options, signal: AbortSignal.abort() });
    expect(
      (await store.conversations.load(options.identity, "one"))?.revision,
    ).toBe(3);
  } finally {
    await store.close();
  }
});
it("stores a summary once and keeps the full turns", async () => {
  const store = await createStorage({
    driver: "sqlite",
    filename: ":memory:",
    encryptionKey: "ab".repeat(32),
  });
  try {
    const provider = createFakeProvider(() => ({
      content: "Hello",
      toolCalls: [],
      finishReason: "stop",
    }));
    const summarizer = createFakeProvider(() => ({
      content: "Asked about a",
      toolCalls: [],
      finishReason: "stop",
    }));
    const options = {
      provider,
      tools: [],
      identity: { actorId: "a", tenantId: "t" },
      system: "Help",
      signal: AbortSignal.timeout(5000),
      conversationId: "one",
      store: store.conversations,
      limits: { maxContextChars: 2000 },
      summarize: { provider: summarizer, keepTurns: 1 },
    };
    for (const input of ["a".repeat(1500), "b".repeat(1000), "c"])
      expect(await runConversation({ ...options, input })).toMatchObject({
        status: "completed",
      });
    expect(summarizer.requests).toHaveLength(1);
    const summary = {
      role: "user",
      content: "[summary of earlier conversation]\nAsked about a",
    };
    expect(provider.requests[2]?.messages).toEqual([
      summary,
      { role: "user", content: "b".repeat(1000) },
      { role: "assistant", content: "Hello", toolCalls: [] },
      { role: "user", content: "c" },
    ]);
    expect(
      (await store.conversations.load(options.identity, "one"))?.messages.map(
        (message) => message.role,
      ),
    ).toEqual([
      "user",
      "assistant",
      "summary",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  } finally {
    await store.close();
  }
});
