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
    ).toBe(2);
  } finally {
    await store.close();
  }
});
