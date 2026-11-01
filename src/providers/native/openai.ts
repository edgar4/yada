import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { z } from "zod";
import { contentText } from "../../core/content.js";
import type {
  Content,
  ContentPart,
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  Turn,
} from "../../core/contracts.js";

export type OpenAISettings = Readonly<{
  name: string;
  model: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  maxRetries: number;
  vision?: boolean | undefined;
  maxTokensParam?: "max_completion_tokens" | "max_tokens";
  extraBody?: Record<string, unknown>;
}>;

const partsOf = (parts: readonly ContentPart[]): ChatCompletionContentPart[] =>
  parts.map((part) =>
    part.type === "text"
      ? part
      : {
          type: "image_url",
          image_url: { url: `data:${part.mimeType};base64,${part.data}` },
        },
  );

const contentOf = (content: Content) =>
  typeof content === "string" ? content : partsOf(content);

function toMessages(system: string, turns: readonly Turn[], name: string) {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];
  let images: ContentPart[] = [];
  const flush = () => {
    if (images.length)
      messages.push({ role: "user", content: partsOf(images) });
    images = [];
  };
  for (const turn of turns) {
    if (turn.role !== "tool") flush();
    switch (turn.role) {
      case "user":
        messages.push({ role: "user", content: contentOf(turn.content) });
        break;
      case "assistant":
        if (turn.providerMetadata && turn.providerMetadata.provider !== name)
          throw new Error("Provider metadata mismatch");
        messages.push({
          role: "assistant",
          content: turn.content || (turn.toolCalls.length ? null : ""),
          ...(turn.toolCalls.length && {
            tool_calls: turn.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            })),
          }),
        });
        break;
      case "tool":
        messages.push({
          role: "tool",
          tool_call_id: turn.toolCallId,
          content: contentText(turn.content),
        });
        if (typeof turn.content !== "string")
          images.push(...turn.content.filter((part) => part.type === "image"));
    }
  }
  flush();
  return messages;
}

type Completion = Readonly<{
  content: string;
  calls: readonly { id: string; name: string; arguments: string }[];
  finish: string | null | undefined;
  refused?: boolean;
  usage?:
    { prompt_tokens: number; completion_tokens: number } | null | undefined;
}>;

const finishReasons: Record<string, ProviderResult["finishReason"]> = {
  stop: "stop",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  length: "length",
  content_filter: "refusal",
};

const toolArgs = z.record(z.string(), z.unknown());

function toResult(completion: Completion): ProviderResult {
  const length = completion.finish === "length";
  const toolCalls = (length ? [] : completion.calls).map((call) => {
    const args = toolArgs.safeParse(
      call.arguments.trim() ? safeJson(call.arguments) : {},
    );
    if (!args.success || !call.id || !call.name)
      throw new Error("Invalid model tool calls");
    return { id: call.id, name: call.name, args: args.data };
  });
  return {
    ...(completion.usage && {
      usage: {
        inputTokens: completion.usage.prompt_tokens,
        outputTokens: completion.usage.completion_tokens,
      },
    }),
    content: completion.content,
    toolCalls,
    finishReason: completion.refused
      ? "refusal"
      : (finishReasons[completion.finish ?? ""] ??
        (toolCalls.length ? "tool_calls" : "other")),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function nativeOpenAIAdapter(settings: OpenAISettings): ProviderAdapter {
  const client = new OpenAI({
    apiKey: settings.apiKey ?? "unused",
    maxRetries: settings.maxRetries,
    ...(settings.baseUrl && { baseURL: settings.baseUrl }),
    ...(settings.headers && { defaultHeaders: settings.headers }),
  });
  const params = (
    request: ProviderRequest,
  ): ChatCompletionCreateParamsNonStreaming => {
    request.signal.throwIfAborted();
    return {
      model: settings.model,
      messages: toMessages(request.system, request.messages, settings.name),
      ...(request.tools.length && {
        tools: request.tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      }),
      ...(settings.maxTokens !== undefined && {
        [settings.maxTokensParam ?? "max_tokens"]: settings.maxTokens,
      }),
      ...(settings.temperature !== undefined && {
        temperature: settings.temperature,
      }),
      ...settings.extraBody,
    };
  };
  return {
    name: settings.name,
    capabilities: { toolCalling: true, vision: settings.vision ?? false },
    async complete(request) {
      const response = await client.chat.completions.create(params(request), {
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      const choice = response.choices[0];
      if (!choice) throw new Error("Empty model response");
      return toResult({
        content: choice.message.content ?? "",
        calls: (choice.message.tool_calls ?? []).flatMap((call) =>
          call.type === "function"
            ? [
                {
                  id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments,
                },
              ]
            : [],
        ),
        finish: choice.finish_reason,
        refused: Boolean(choice.message.refusal),
        usage: response.usage,
      });
    },
    async *stream(request) {
      let content = "";
      let finish: string | null | undefined;
      let usage: Completion["usage"];
      let seen = false;
      let refused = false;
      const calls: { id: string; name: string; arguments: string }[] = [];
      const chunks = await client.chat.completions.create(
        {
          ...params(request),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: request.signal },
      );
      for await (const chunk of chunks) {
        seen = true;
        usage = chunk.usage ?? usage;
        const choice = chunk.choices[0];
        if (!choice) continue;
        finish = choice.finish_reason ?? finish;
        refused ||= Boolean(choice.delta.refusal);
        if (choice.delta.content) {
          content += choice.delta.content;
          yield { type: "text", delta: choice.delta.content };
        }
        for (const call of choice.delta.tool_calls ?? []) {
          const current = (calls[call.index] ??= {
            id: "",
            name: "",
            arguments: "",
          });
          current.id ||= call.id ?? "";
          current.name += call.function?.name ?? "";
          current.arguments += call.function?.arguments ?? "";
        }
      }
      request.signal.throwIfAborted();
      if (!seen) throw new Error("Empty model stream");
      return toResult({
        content,
        calls: calls.filter(Boolean),
        finish,
        refused,
        usage,
      });
    },
  };
}
