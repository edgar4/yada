import { vi } from "vitest";
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
export const chatReply = (
  message: object = { content: "ok" },
  finish = "stop",
) =>
  json({
    id: "c",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        finish_reason: finish,
        message: { role: "assistant", ...message },
      },
    ],
  });
export const claudeReply = (
  content: object[] = [{ type: "text", text: "ok" }],
  stop_reason = "end_turn",
) =>
  json({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "m",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
export function stubFetch(
  respond: (call: number, body: Record<string, unknown>) => Response,
) {
  const calls: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      calls.push({
        url: String(url),
        headers: new Headers(init.headers),
        body,
      });
      return Promise.resolve(respond(calls.length, body));
    }),
  );
  return calls;
}
