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
type Block = { type: string } & Record<string, unknown>;
const sseEvents = (events: [string, object][]) =>
  new Response(
    events
      .map(
        ([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const blockStream = (block: Block, index: number): [string, object][] => {
  const delta = (data: object): [string, object] => [
    "content_block_delta",
    { type: "content_block_delta", index, delta: data },
  ];
  const start = (content: object): [string, object] => [
    "content_block_start",
    { type: "content_block_start", index, content_block: content },
  ];
  const stop: [string, object] = [
    "content_block_stop",
    { type: "content_block_stop", index },
  ];
  switch (block.type) {
    case "text":
      return [
        start({ type: "text", text: "" }),
        delta({ type: "text_delta", text: block["text"] }),
        stop,
      ];
    case "thinking":
      return [
        start({ ...block, thinking: "", signature: "" }),
        delta({ type: "thinking_delta", thinking: block["thinking"] }),
        delta({ type: "signature_delta", signature: block["signature"] ?? "" }),
        stop,
      ];
    case "tool_use":
      return [
        start({ ...block, input: {} }),
        delta({
          type: "input_json_delta",
          partial_json: JSON.stringify(block["input"]),
        }),
        stop,
      ];
    default:
      return [start(block), stop];
  }
};
export const claudeReply = (
  content: Block[] = [{ type: "text", text: "ok" }],
  stop_reason = "end_turn",
) =>
  sseEvents([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "m",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    ...content.flatMap(blockStream),
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
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
