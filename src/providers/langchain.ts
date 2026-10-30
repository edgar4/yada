import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import type { ProviderAdapter, Turn } from "../core/contracts.js";
function toMessage(turn: Turn, provider: string): BaseMessage {
  switch (turn.role) {
    case "user":
      return new HumanMessage(turn.content);
    case "assistant":
      if (turn.providerMetadata && turn.providerMetadata.provider !== provider)
        throw new Error("Provider metadata mismatch");
      return new AIMessage({
        content: turn.content,
        additional_kwargs: turn.providerMetadata?.data ?? {},
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: z.record(z.string(), z.unknown()).parse(call.args),
          type: "tool_call",
        })),
      });
    case "tool":
      return new ToolMessage({
        content: turn.content,
        tool_call_id: turn.toolCallId,
        name: turn.name,
      });
  }
}
export function chatModelAdapter(
  name: string,
  model: BaseChatModel,
): ProviderAdapter {
  return {
    name,
    capabilities: { toolCalling: typeof model.bindTools === "function" },
    async complete(request) {
      request.signal.throwIfAborted();
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
      const message = await bound.invoke(
        [
          new SystemMessage(request.system),
          ...request.messages.map((turn) => toMessage(turn, name)),
        ],
        { signal: request.signal },
      );
      request.signal.throwIfAborted();
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
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => z.object({ text: z.string() }).parse(block).text)
              .join("");
      const finishReason =
        normalizedReason === "max_tokens" || normalizedReason === "length"
          ? "length"
          : toolCalls.length
            ? "tool_calls"
            : normalizedReason === "end_turn" || normalizedReason === "stop"
              ? "stop"
              : "other";
      const usage = z
        .object({
          usage_metadata: z
            .object({
              input_tokens: z.number().int().nonnegative().optional(),
              output_tokens: z.number().int().nonnegative().optional(),
            })
            .optional(),
        })
        .parse(message).usage_metadata;
      return {
        ...(usage?.input_tokens !== undefined &&
        usage.output_tokens !== undefined
          ? {
              usage: {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
              },
            }
          : {}),
        content,
        toolCalls,
        finishReason,
        ...(Object.keys(message.additional_kwargs).length
          ? {
              providerMetadata: {
                provider: name,
                data: message.additional_kwargs,
              },
            }
          : {}),
      };
    },
  };
}
