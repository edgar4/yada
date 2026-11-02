import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputContent,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { z } from "zod";
import { contentText } from "../../core/content.js";
import { withTrailingImages } from "../shared.js";
import type {
  Content,
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  Turn,
} from "../../core/contracts.js";
import { toResult, type OpenAISettings } from "./openai.js";

const inputOf = (content: Content): string | ResponseInputContent[] =>
  typeof content === "string"
    ? content
    : content.map((part) =>
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : {
              type: "input_image",
              detail: "auto",
              image_url: `data:${part.mimeType};base64,${part.data}`,
            },
      );

const reasoningItems = z.array(z.looseObject({ type: z.literal("reasoning") }));

function toItems(turn: Turn, name: string): ResponseInputItem[] {
  switch (turn.role) {
    case "user":
      return [{ role: "user", content: inputOf(turn.content) }];
    case "assistant": {
      const { providerMetadata } = turn;
      if (
        providerMetadata &&
        (providerMetadata.provider !== name ||
          providerMetadata.data["api"] !== "responses")
      )
        throw new Error("Provider metadata mismatch");
      return [
        ...(reasoningItems.parse(
          providerMetadata?.data["reasoning"] ?? [],
        ) as unknown as ResponseInputItem[]),
        ...(turn.content
          ? [{ role: "assistant" as const, content: turn.content }]
          : []),
        ...turn.toolCalls.map((call) => ({
          type: "function_call" as const,
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        })),
      ];
    }
    case "tool":
      return [
        {
          type: "function_call_output",
          call_id: turn.toolCallId,
          output: contentText(turn.content),
        },
      ];
  }
}

function toProviderResult(response: Response, name: string): ProviderResult {
  if (response.status === "failed" || response.status === "cancelled")
    throw new Error(response.error?.message ?? "Model response failed");
  const reasoning = response.output.filter((item) => item.type === "reasoning");
  const parts = response.output.flatMap((item) =>
    item.type === "message" ? item.content : [],
  );
  const reason = response.incomplete_details?.reason;
  const { usage } = response;
  return {
    ...toResult({
      content: parts
        .flatMap((part) => (part.type === "output_text" ? [part.text] : []))
        .join(""),
      calls: response.output.flatMap((item) =>
        item.type === "function_call"
          ? [{ id: item.call_id, name: item.name, arguments: item.arguments }]
          : [],
      ),
      finish:
        response.status === "incomplete"
          ? reason === "max_output_tokens"
            ? "length"
            : reason
          : "stop",
      refused: parts.some((part) => part.type === "refusal"),
      usage: usage && {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        prompt_tokens_details: {
          cached_tokens: usage.input_tokens_details.cached_tokens,
        },
      },
    }),
    ...(reasoning.length && {
      providerMetadata: {
        provider: name,
        data: { api: "responses", reasoning },
      },
    }),
  };
}

export function nativeOpenAIResponsesAdapter(
  settings: OpenAISettings,
): ProviderAdapter {
  const client = new OpenAI({
    apiKey: settings.apiKey ?? "unused",
    maxRetries: settings.maxRetries,
    ...(settings.baseUrl && { baseURL: settings.baseUrl }),
    ...(settings.headers && { defaultHeaders: settings.headers }),
  });
  const params = (
    request: ProviderRequest,
  ): ResponseCreateParamsNonStreaming => {
    request.signal.throwIfAborted();
    return {
      model: settings.model,
      instructions: request.system,
      input: withTrailingImages<ResponseInputItem[]>(
        request.messages,
        (turn) => toItems(turn, settings.name),
        (images) => [{ role: "user", content: inputOf(images) }],
      ).flat(),
      store: false,
      include: ["reasoning.encrypted_content"],
      ...(request.tools.length && {
        tools: request.tools.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
      }),
      ...(settings.maxTokens !== undefined && {
        max_output_tokens: settings.maxTokens,
      }),
      ...(settings.temperature !== undefined && {
        temperature: settings.temperature,
      }),
      ...(settings.effort && { reasoning: { effort: settings.effort } }),
    };
  };
  return {
    name: settings.name,
    capabilities: { toolCalling: true, vision: settings.vision ?? false },
    async complete(request) {
      const response = await client.responses.create(params(request), {
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      return toProviderResult(response, settings.name);
    },
    async *stream(request) {
      const events = await client.responses.create(
        { ...params(request), stream: true },
        { signal: request.signal },
      );
      let final: Response | undefined;
      for await (const event of events) {
        if (event.type === "response.output_text.delta")
          yield { type: "text", delta: event.delta };
        else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed"
        )
          final = event.response;
      }
      request.signal.throwIfAborted();
      if (!final) throw new Error("Empty model stream");
      return toProviderResult(final, settings.name);
    },
  };
}
