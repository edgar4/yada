import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { ServerToolSettings } from "../options.js";
import { uniqueSources } from "../shared.js";
import type {
  Content,
  ProviderAdapter,
  ProviderDelta,
  ProviderRequest,
  ProviderResult,
  Turn,
} from "../../core/contracts.js";

export type AnthropicSettings = ServerToolSettings &
  Readonly<{
    apiKey: string;
    model: string;
    maxTokens: number;
    maxRetries: number;
    timeoutMs?: number | undefined;
    baseUrl?: string | undefined;
    headers?: Record<string, string> | undefined;
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
    thinkingDisplay?: "summarized" | "omitted" | undefined;
    promptCache?: "off" | "5m" | "1h" | undefined;
  }>;

const blocksOf = (content: Content): ContentBlockParam[] =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map((part) =>
        part.type === "text"
          ? part
          : {
              type: "image",
              source: {
                type: "base64",
                media_type: part.mimeType,
                data: part.data,
              },
            },
      );

const maxContinuations = 3;

const thinkingBlocks = z.array(
  z.looseObject({ type: z.enum(["thinking", "redacted_thinking"]) }),
);

function toMessages(turns: readonly Turn[]) {
  const messages: MessageParam[] = [];
  const add = (role: "user" | "assistant", content: ContentBlockParam[]) => {
    if (!content.length) return;
    const last = messages.at(-1);
    if (last?.role === role)
      (last.content as ContentBlockParam[]).push(...content);
    else messages.push({ role, content });
  };
  for (const turn of turns) {
    switch (turn.role) {
      case "user":
        add("user", blocksOf(turn.content));
        break;
      case "tool":
        add("user", [
          {
            type: "tool_result",
            tool_use_id: turn.toolCallId,
            content:
              typeof turn.content === "string"
                ? turn.content
                : (blocksOf(turn.content) as never),
          },
        ]);
        break;
      case "assistant": {
        if (
          turn.providerMetadata &&
          turn.providerMetadata.provider !== "anthropic"
        )
          throw new Error("Provider metadata mismatch");
        const stored = z
          .array(z.looseObject({ type: z.string() }))
          .optional()
          .parse(turn.providerMetadata?.data["contentBlocks"]);
        let calls = 0;
        add(
          "assistant",
          stored
            ? (stored.map((block) =>
                block.type === "tool_use"
                  ? { ...block, id: turn.toolCalls[calls++]?.id ?? block["id"] }
                  : block,
              ) as unknown as ContentBlockParam[])
            : [
                ...(thinkingBlocks.parse(
                  turn.providerMetadata?.data["thinkingBlocks"] ?? [],
                ) as unknown as ContentBlockParam[]),
                ...(turn.content
                  ? [{ type: "text" as const, text: turn.content }]
                  : []),
                ...turn.toolCalls.map((call) => ({
                  type: "tool_use" as const,
                  id: call.id,
                  name: call.name,
                  input: z.record(z.string(), z.unknown()).parse(call.args),
                })),
              ],
        );
      }
    }
  }
  return messages;
}

const finishReasons: Record<string, ProviderResult["finishReason"]> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "refusal",
};

function toResult(message: {
  content: ContentBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}): ProviderResult {
  const replay = message.content.some(
    (block) =>
      block.type === "thinking" ||
      block.type === "redacted_thinking" ||
      block.type === "server_tool_use",
  );
  const sources = uniqueSources(
    message.content.flatMap((block) =>
      block.type === "web_search_tool_result" && Array.isArray(block.content)
        ? block.content.map(({ url, title }) => ({ url, title }))
        : [],
    ),
  );
  const serverToolCalls = message.content.filter(
    (block) => block.type === "server_tool_use",
  ).length;
  const { usage } = message;
  return {
    usage: {
      inputTokens:
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      ...(usage.cache_read_input_tokens && {
        cacheReadTokens: usage.cache_read_input_tokens,
      }),
      ...(usage.cache_creation_input_tokens && {
        cacheWriteTokens: usage.cache_creation_input_tokens,
      }),
      ...(serverToolCalls && { serverToolCalls }),
    },
    content: message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(""),
    toolCalls: message.content.flatMap((block) =>
      block.type === "tool_use"
        ? [{ id: block.id, name: block.name, args: block.input }]
        : [],
    ),
    finishReason: finishReasons[message.stop_reason ?? ""] ?? "other",
    ...(replay
      ? {
          providerMetadata: {
            provider: "anthropic",
            data: {
              contentBlocks: message.content,
              ...(sources.length && { sources }),
            },
          },
        }
      : {}),
  };
}

export function nativeAnthropicAdapter(
  settings: AnthropicSettings,
): ProviderAdapter {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    maxRetries: settings.maxRetries,
    ...(settings.timeoutMs && { timeout: settings.timeoutMs }),
    ...(settings.baseUrl && { baseURL: settings.baseUrl }),
    ...(settings.headers && { defaultHeaders: settings.headers }),
  });
  const params = (
    request: ProviderRequest,
  ): MessageCreateParamsNonStreaming => {
    request.signal.throwIfAborted();
    const cache = settings.promptCache ?? "5m";
    const cacheControl =
      cache === "off"
        ? undefined
        : {
            type: "ephemeral" as const,
            ...(cache === "1h" && { ttl: cache }),
          };
    const tools: ToolUnion[] = [
      ...request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as { type: "object" },
      })),
      ...(settings.serverTools ?? []).map((name): ToolUnion =>
        name === "web_search"
          ? {
              type: "web_search_20260318",
              name,
              ...(settings.webSearch?.maxUses && {
                max_uses: settings.webSearch.maxUses,
              }),
              ...(settings.webSearch?.allowedDomains && {
                allowed_domains: settings.webSearch.allowedDomains,
              }),
            }
          : { type: "code_execution_20260521", name },
      ),
    ];
    return {
      model: settings.model,
      max_tokens: settings.maxTokens,
      system:
        cacheControl && request.system
          ? [
              {
                type: "text",
                text: request.system,
                cache_control: cacheControl,
              },
            ]
          : request.system,
      ...(cacheControl && { cache_control: cacheControl }),
      messages: toMessages(request.messages),
      ...(tools.length && { tools }),
      ...(settings.effort && { output_config: { effort: settings.effort } }),
      ...(settings.thinkingDisplay && {
        thinking: { type: "adaptive", display: settings.thinkingDisplay },
      }),
    };
  };
  async function* generate(
    request: ProviderRequest,
  ): AsyncGenerator<ProviderDelta, ProviderResult> {
    const base = params(request);
    const content: ContentBlock[] = [];
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    for (let leg = 0; ; leg++) {
      const stream = client.messages.stream(
        {
          ...base,
          messages: [
            ...base.messages,
            ...(content.length
              ? [
                  {
                    role: "assistant" as const,
                    content: content as ContentBlockParam[],
                  },
                ]
              : []),
          ],
        },
        { signal: request.signal },
      );
      for await (const event of stream)
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        )
          yield { type: "text", delta: event.delta.text };
      const message = await stream.finalMessage();
      request.signal.throwIfAborted();
      content.push(...message.content);
      for (const key of Object.keys(usage) as (keyof typeof usage)[])
        usage[key] += message.usage[key] ?? 0;
      if (message.stop_reason !== "pause_turn" || leg === maxContinuations)
        return toResult({ ...message, content, usage });
    }
  }
  return {
    name: "anthropic",
    capabilities: { toolCalling: true, vision: true, retries: true },
    async complete(request) {
      const run = generate(request);
      for (;;) {
        const next = await run.next();
        if (next.done) return next.value;
      }
    },
    stream: generate,
  };
}
