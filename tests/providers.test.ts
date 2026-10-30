import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessageChunk } from "@langchain/core/messages";
import { chatModelAdapter } from "../src/providers/langchain.js";
import {
  createAnthropicProvider,
  createFakeProvider,
  run,
} from "../src/index.js";
import type { ProviderRequest } from "../src/index.js";
const request: ProviderRequest = {
  system: "Help",
  messages: [{ role: "user", content: "Hi" }],
  tools: [],
  signal: new AbortController().signal,
};
function setup(message: AIMessageChunk) {
  const model = new ChatAnthropic({
    apiKey: "test",
    model: "test",
    maxRetries: 0,
  });
  const invoke = vi.spyOn(model, "invoke").mockResolvedValue(message);
  const bind = vi.spyOn(model, "bindTools").mockReturnValue(model);
  return { model, invoke, bind, provider: chatModelAdapter("test", model) };
}
afterEach(() => vi.restoreAllMocks());
describe("provider adapters", () => {
  it.each(["fake", "anthropic"])(
    "runs the same chat contract for %s",
    async (name) => {
      const provider =
        name === "fake"
          ? createFakeProvider(() => ({
              content: "Hello",
              toolCalls: [],
              finishReason: "stop",
            }))
          : setup(
              new AIMessageChunk({
                content: "Hello",
                response_metadata: { stop_reason: "end_turn" },
              }),
            ).provider;
      expect(
        await run({
          provider,
          tools: [],
          identity: { actorId: "a", tenantId: "t" },
          input: "Hi",
          system: "Help",
          signal: request.signal,
        }),
      ).toEqual({ status: "completed", text: "Hello" });
    },
  );
  it("maps history and tool results without losing text", async () => {
    const s = setup(
      new AIMessageChunk({
        content: [{ type: "text", text: "Found" }],
        tool_calls: [{ id: "2", name: "lookup", args: { id: "a" } }],
        response_metadata: { stop_reason: "tool_use" },
      }),
    );
    const result = await s.provider.complete({
      ...request,
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object" },
        },
      ],
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: "Checking",
          toolCalls: [{ id: "1", name: "lookup", args: { id: "a" } }],
        },
        { role: "tool", toolCallId: "1", name: "lookup", content: "Available" },
      ],
    });
    expect(result).toEqual({
      content: "Found",
      toolCalls: [{ id: "2", name: "lookup", args: { id: "a" } }],
      finishReason: "tool_calls",
    });
    expect(s.bind).toHaveBeenCalledOnce();
    expect(s.invoke.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Checking" }),
        expect.objectContaining({ content: "Available" }),
      ]),
    );
  });
  it.each(["max_tokens", "length"])(
    "preserves truncation even with tools: %s",
    async (stop_reason) => {
      const s = setup(
        new AIMessageChunk({
          content: "",
          tool_calls: [{ id: "1", name: "lookup", args: {} }],
          response_metadata: { stop_reason },
        }),
      );
      expect((await s.provider.complete(request)).finishReason).toBe("length");
    },
  );
  it("rejects malformed calls", async () => {
    const s = setup(
      new AIMessageChunk({
        content: "",
        tool_call_chunks: [
          {
            name: "lookup",
            id: "bad",
            index: 0,
            args: "not-json",
            type: "tool_call_chunk",
          },
        ],
      }),
    );
    await expect(s.provider.complete(request)).rejects.toThrow("Invalid model");
  });
  it("rejects missing call IDs", async () => {
    const s = setup(
      new AIMessageChunk({
        content: "",
        tool_calls: [{ name: "lookup", args: {} }],
      }),
    );
    await expect(s.provider.complete(request)).rejects.toThrow();
  });
  it("preserves unknown finish reasons", async () => {
    const s = setup(new AIMessageChunk("Hi"));
    expect((await s.provider.complete(request)).finishReason).toBe("other");
  });
  it("propagates cancellation before network access", async () => {
    const s = setup(new AIMessageChunk("Hi"));
    await expect(
      s.provider.complete({ ...request, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it("validates configuration and builds a real adapter", () => {
    expect(() => createAnthropicProvider({ apiKey: "", model: "x" })).toThrow();
    expect(
      createAnthropicProvider({ apiKey: "test", model: "test" }).name,
    ).toBe("anthropic");
  });
});
