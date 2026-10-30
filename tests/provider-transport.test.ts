import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createProvider, readTool, run } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
it.each(["openai", "gemini", "deepseek", "ollama", "llamacpp"] as const)(
  "round trips through the real %s SDK with mocked HTTP",
  async (provider) => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request body");
      bodies.push(JSON.parse(init.body) as unknown);
      const first = bodies.length === 1;
      const body =
        provider !== "gemini"
          ? {
              id: "completion",
              object: "chat.completion",
              created: 1,
              model: "test",
              choices: [
                {
                  index: 0,
                  finish_reason: first ? "tool_calls" : "stop",
                  message: first
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call_1",
                            type: "function",
                            function: {
                              name: "lookup",
                              arguments: '{"id":"a"}',
                            },
                          },
                        ],
                      }
                    : { role: "assistant", content: "Available" },
                },
              ],
            }
          : {
              candidates: [
                {
                  index: 0,
                  finishReason: "STOP",
                  content: {
                    role: "model",
                    parts: first
                      ? [
                          {
                            functionCall: { name: "lookup", args: { id: "a" } },
                            thoughtSignature: "signature",
                          },
                        ]
                      : [{ text: "Available" }],
                  },
                },
              ],
            };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await run({
      provider: createProvider({ provider, apiKey: "test", model: "test" }),
      tools: [
        readTool({
          name: "lookup",
          description: "Lookup",
          input: z.strictObject({ id: z.string() }),
          authorize: () => Promise.resolve(true),
          execute: () => Promise.resolve("Available"),
        }),
      ],
      identity: { actorId: "a", tenantId: "t" },
      input: "Find a",
      system: "Help",
      signal: AbortSignal.timeout(3000),
    });
    expect(result).toEqual({ status: "completed", text: "Available" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (provider === "gemini") {
      expect(JSON.stringify(bodies[1])).toContain(
        '"thoughtSignature":"signature"',
      );
      expect(JSON.stringify(bodies[0])).not.toContain("$schema");
    } else
      expect(JSON.stringify(bodies[1])).toContain('"tool_call_id":"call_1"');
  },
);
it.each(["openai", "gemini", "deepseek", "ollama", "llamacpp"] as const)(
  "does not retry or leak %s HTTP auth failures",
  async (provider) => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "private-secret",
              status: "UNAUTHENTICATED",
              code: 401,
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await run({
        provider: createProvider({ provider, apiKey: "test", model: "test" }),
        tools: [],
        identity: { actorId: "a", tenantId: "t" },
        input: "Hi",
        system: "Help",
        signal: AbortSignal.timeout(3000),
      }),
    ).toEqual({ status: "failed", code: "dependency_failed" });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);
