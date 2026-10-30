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
function toMessage(turn: Turn): BaseMessage {
  switch (turn.role) {
    case "user":
      return new HumanMessage(turn.content);
    case "assistant":
      return new AIMessage({
        content: turn.content,
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
        [new SystemMessage(request.system), ...request.messages.map(toMessage)],
        { signal: request.signal },
      );
      request.signal.throwIfAborted();
      if (message.invalid_tool_calls?.length)
        throw new Error("Invalid model tool calls");
      const reason: unknown =
        message.response_metadata["stop_reason"] ??
        message.response_metadata["finish_reason"];
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
        reason === "max_tokens" || reason === "length"
          ? "length"
          : toolCalls.length
            ? "tool_calls"
            : reason === "end_turn" || reason === "stop"
              ? "stop"
              : "other";
      return { content, toolCalls, finishReason };
    },
  };
}
