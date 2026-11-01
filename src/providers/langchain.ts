import type {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  ContentBlock,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import { optionalImport } from "../optional.js";
import { contentText } from "../core/content.js";
import { imageUrlParts, withTrailingImages } from "./shared.js";
import type {
  Content,
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  Turn,
} from "../core/contracts.js";
type Messages = typeof import("@langchain/core/messages");
const loadMessages = () =>
  optionalImport(
    () => import("@langchain/core/messages"),
    "@langchain/core",
    "LangChain-based providers",
  );
const blocks = (content: Content) =>
  typeof content === "string" ? content : imageUrlParts(content);
function toMessage(
  { AIMessage, HumanMessage, ToolMessage }: Messages,
  turn: Turn,
  provider: string,
): BaseMessage {
  switch (turn.role) {
    case "user":
      return new HumanMessage({ content: blocks(turn.content) });
    case "assistant": {
      if (turn.providerMetadata && turn.providerMetadata.provider !== provider)
        throw new Error("Provider metadata mismatch");
      const { thinkingBlocks, ...kwargs } = turn.providerMetadata?.data ?? {};
      return new AIMessage({
        content: Array.isArray(thinkingBlocks)
          ? [
              ...(thinkingBlocks as ContentBlock[]),
              ...(turn.content ? [{ type: "text", text: turn.content }] : []),
            ]
          : turn.content,
        additional_kwargs: kwargs,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: z.record(z.string(), z.unknown()).parse(call.args),
          type: "tool_call",
        })),
      });
    }
    case "tool":
      return new ToolMessage({
        content: contentText(turn.content),
        tool_call_id: turn.toolCallId,
        name: turn.name,
      });
  }
}
function toMessages(
  messagesModule: Messages,
  turns: readonly Turn[],
  provider: string,
) {
  return withTrailingImages<BaseMessage>(
    turns,
    (turn) => toMessage(messagesModule, turn, provider),
    (images) => new messagesModule.HumanMessage({ content: blocks(images) }),
  );
}
const refusalReasons = new Set([
  "refusal",
  "content_filter",
  "safety",
  "recitation",
  "prohibited_content",
  "blocklist",
  "spii",
]);
const descriptive = new Set([
  "id",
  "type",
  "role",
  "model",
  "usage",
  "stop_reason",
  "stop_sequence",
  "finishReason",
  "index",
]);
const withoutIndex = <T>(value: T): T =>
  typeof value === "object" && value !== null
    ? (Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "index"),
      ) as T)
    : value;
const usageOf = (message: unknown) =>
  z
    .object({
      usage_metadata: z
        .object({
          input_tokens: z.number().int().nonnegative().optional(),
          output_tokens: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .parse(message).usage_metadata;
const textOf = (content: BaseMessage["content"]) =>
  typeof content === "string"
    ? content
    : content
        .filter((block) => block.type === "text")
        .map((block) => z.object({ text: z.string() }).parse(block).text)
        .join("");
function toResult(
  message: AIMessage,
  name: string,
  startedOutputTokens = 0,
): ProviderResult {
  if (message.invalid_tool_calls?.length)
    throw new Error("Invalid model tool calls");
  const reason: unknown =
    message.response_metadata["stop_reason"] ??
    message.response_metadata["finish_reason"] ??
    message.response_metadata["finishReason"];
  const normalizedReason =
    typeof reason === "string" ? reason.toLowerCase() : "";
  const toolCalls = (message.tool_calls ?? []).map((call) => ({
    id: z.string().min(1).parse(call.id),
    name: call.name,
    args: call.args,
  }));
  const content = textOf(message.content);
  const thinkingBlocks = Array.isArray(message.content)
    ? message.content
        .filter(
          (block) =>
            block.type === "thinking" || block.type === "redacted_thinking",
        )
        .map(withoutIndex)
    : [];
  const metadata = {
    ...Object.fromEntries(
      Object.entries(message.additional_kwargs)
        .filter(([key, value]) => !descriptive.has(key) && value !== undefined)
        .map(([key, value]) => [
          key,
          key === "tool_calls" && Array.isArray(value)
            ? value.map(withoutIndex)
            : value,
        ]),
    ),
    ...(thinkingBlocks.length ? { thinkingBlocks } : {}),
  };
  const finishReason =
    normalizedReason === "max_tokens" || normalizedReason === "length"
      ? "length"
      : refusalReasons.has(normalizedReason)
        ? "refusal"
        : toolCalls.length
          ? "tool_calls"
          : normalizedReason === "end_turn" || normalizedReason === "stop"
            ? "stop"
            : "other";
  const usage = usageOf(message);
  return {
    ...(usage?.input_tokens !== undefined && usage.output_tokens !== undefined
      ? {
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens - startedOutputTokens,
          },
        }
      : {}),
    content,
    toolCalls,
    finishReason,
    ...(Object.keys(metadata).length
      ? { providerMetadata: { provider: name, data: metadata } }
      : {}),
  };
}
export function chatModelAdapter(
  name: string,
  source: BaseChatModel | (() => Promise<BaseChatModel>),
  vision = false,
): ProviderAdapter {
  let loaded: Promise<readonly [Messages, BaseChatModel]> | undefined;
  const load = () =>
    (loaded ??= (async () => {
      const model = typeof source === "function" ? await source() : source;
      return [await loadMessages(), model] as const;
    })());
  const prepare = async (request: ProviderRequest) => {
    request.signal.throwIfAborted();
    const [messages, model] = await load();
    const tools = request.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    const bound = tools.length ? model.bindTools?.(tools) : model;
    if (!bound) throw new Error("Model does not support tools");
    return {
      bound,
      messages: [
        new messages.SystemMessage(request.system),
        ...toMessages(messages, request.messages, name),
      ],
    };
  };
  return {
    name,
    capabilities: {
      toolCalling:
        typeof source === "function" || typeof source.bindTools === "function",
      vision,
    },
    async complete(request) {
      const { bound, messages } = await prepare(request);
      const message = await bound.invoke(messages, { signal: request.signal });
      request.signal.throwIfAborted();
      return toResult(message, name);
    },
    async *stream(request) {
      const { bound, messages } = await prepare(request);
      let message: AIMessageChunk | undefined;
      let started = 0;
      for await (const chunk of await bound.stream(messages, {
        signal: request.signal,
      })) {
        const source: unknown = chunk.response_metadata["model_provider"];
        if (!message && source === "anthropic")
          started = usageOf(chunk)?.output_tokens ?? 0;
        message = message ? message.concat(chunk) : chunk;
        const delta = textOf(chunk.content);
        if (delta) yield { type: "text", delta };
      }
      request.signal.throwIfAborted();
      if (!message) throw new Error("Empty model stream");
      return toResult(message, name, started);
    },
  };
}
