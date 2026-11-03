import type {
  Content as GeminiContent,
  GenerateContentConfig,
  GenerateContentResponse,
  GroundingMetadata,
  GoogleGenAI,
  Part,
  ThinkingLevel,
  Tool,
} from "@google/genai";
import { z } from "zod";
import { contentText } from "../../core/content.js";
import { optionalImport } from "../../optional.js";
import { uniqueSources, withTrailingImages } from "../shared.js";
import type { ServerToolSettings } from "../options.js";
import type {
  Content,
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  Turn,
} from "../../core/contracts.js";

export type GeminiSettings = Pick<ServerToolSettings, "serverTools"> &
  Readonly<{
    apiKey: string;
    model: string;
    maxTokens: number;
    maxRetries: number;
    timeoutMs?: number | undefined;
    baseUrl?: string | undefined;
    headers?: Record<string, string> | undefined;
    temperature?: number | undefined;
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  }>;

const generatedPrefix = "gemini_call_";

const partsOf = (content: Content): Part[] =>
  typeof content === "string"
    ? [{ text: content }]
    : content.map((part) =>
        part.type === "text"
          ? { text: part.text }
          : { inlineData: { mimeType: part.mimeType, data: part.data } },
      );

const storedParts = z.array(z.looseObject({}));

function toContent(turn: Turn): GeminiContent {
  switch (turn.role) {
    case "user":
      return { role: "user", parts: partsOf(turn.content) };
    case "tool":
      return {
        role: "user",
        parts: [
          {
            functionResponse: {
              ...(!turn.toolCallId.startsWith(generatedPrefix) && {
                id: turn.toolCallId,
              }),
              name: turn.name,
              response: { result: contentText(turn.content) },
            },
          },
        ],
      };
    case "assistant": {
      if (turn.providerMetadata && turn.providerMetadata.provider !== "gemini")
        throw new Error("Provider metadata mismatch");
      const stored = storedParts
        .optional()
        .parse(turn.providerMetadata?.data["parts"]) as Part[] | undefined;
      let calls = 0;
      const call = (name: string | undefined, args: unknown) => {
        const id = turn.toolCalls[calls++]?.id;
        return {
          ...(id && !id.startsWith(generatedPrefix) && { id }),
          ...(name && { name }),
          args: z.record(z.string(), z.unknown()).parse(args),
        };
      };
      return {
        role: "model",
        parts: stored
          ? stored.map((part) =>
              part.functionCall
                ? {
                    ...part,
                    functionCall: call(
                      part.functionCall.name,
                      part.functionCall.args,
                    ),
                  }
                : part,
            )
          : [
              ...(turn.content ? [{ text: turn.content }] : []),
              ...turn.toolCalls.map((toolCall) => ({
                functionCall: call(toolCall.name, toolCall.args),
              })),
            ],
      };
    }
  }
}

const toContents = (turns: readonly Turn[]) =>
  withTrailingImages<GeminiContent>(turns, toContent, (images) => ({
    role: "user",
    parts: partsOf(images),
  })).reduce<GeminiContent[]>((merged, content) => {
    const last = merged.at(-1);
    if (last && last.role === content.role)
      last.parts = [...(last.parts ?? []), ...(content.parts ?? [])];
    else merged.push(content);
    return merged;
  }, []);

const refusals = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "BLOCKLIST",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

type Completion = Readonly<{
  parts: readonly Part[];
  finish: string | undefined;
  blocked: boolean;
  usage: GenerateContentResponse["usageMetadata"];
  grounding: readonly GroundingMetadata[];
}>;

function toResult({
  parts,
  finish,
  blocked,
  usage,
  grounding,
}: Completion): ProviderResult {
  const length = finish === "MAX_TOKENS";
  const toolCalls = length
    ? []
    : parts.flatMap((part, index) =>
        part.functionCall?.name
          ? [
              {
                id:
                  part.functionCall.id || `${generatedPrefix}${String(index)}`,
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
              },
            ]
          : [],
      );
  const sources = uniqueSources(
    grounding.flatMap((metadata) =>
      (metadata.groundingChunks ?? []).flatMap(({ web }) =>
        web?.uri ? [{ url: web.uri, title: web.title ?? web.uri }] : [],
      ),
    ),
  );
  const serverToolCalls =
    grounding.reduce(
      (total, metadata) => total + (metadata.webSearchQueries?.length ?? 0),
      0,
    ) + parts.filter((part) => part.executableCode).length;
  return {
    ...((usage || serverToolCalls) && {
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens:
          (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        ...(usage?.cachedContentTokenCount && {
          cacheReadTokens: usage.cachedContentTokenCount,
        }),
        ...(serverToolCalls && { serverToolCalls }),
      },
    }),
    content: parts
      .flatMap((part) => (part.text && !part.thought ? [part.text] : []))
      .join(""),
    toolCalls,
    finishReason:
      blocked || refusals.has(finish ?? "")
        ? "refusal"
        : length
          ? "length"
          : toolCalls.length
            ? "tool_calls"
            : finish === "STOP"
              ? "stop"
              : "other",
    ...(parts.some(
      (part) =>
        part.thoughtSignature ||
        part.executableCode ||
        part.codeExecutionResult,
    ) || sources.length
      ? {
          providerMetadata: {
            provider: "gemini",
            data: { parts, ...(sources.length && { sources }) },
          },
        }
      : {}),
  };
}

const completion = (chunks: readonly GenerateContentResponse[]): Completion => {
  const candidates = chunks.flatMap((chunk) => chunk.candidates?.[0] ?? []);
  return {
    parts: candidates
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .reduce<Part[]>((merged, part) => {
        const last = merged.at(-1);
        if (
          last?.text !== undefined &&
          part.text !== undefined &&
          !last.thoughtSignature &&
          Boolean(last.thought) === Boolean(part.thought)
        )
          merged[merged.length - 1] = { ...part, text: last.text + part.text };
        else merged.push(part);
        return merged;
      }, []),
    finish: candidates
      .flatMap((candidate) => candidate.finishReason ?? [])
      .at(-1),
    blocked: chunks.some((chunk) => chunk.promptFeedback?.blockReason),
    usage: chunks.flatMap((chunk) => chunk.usageMetadata ?? []).at(-1),
    grounding: candidates.flatMap(
      (candidate) => candidate.groundingMetadata ?? [],
    ),
  };
};

export function nativeGeminiAdapter(settings: GeminiSettings): ProviderAdapter {
  let client: Promise<GoogleGenAI> | undefined;
  const load = () =>
    (client ??= optionalImport(
      () => import("@google/genai"),
      "@google/genai",
      "The Gemini provider",
    ).then(
      ({ GoogleGenAI }) =>
        new GoogleGenAI({
          apiKey: settings.apiKey,
          httpOptions: {
            retryOptions: { attempts: settings.maxRetries + 1 },
            ...(settings.timeoutMs && { timeout: settings.timeoutMs }),
            ...(settings.baseUrl && { baseUrl: settings.baseUrl }),
            ...(settings.headers && { headers: settings.headers }),
          },
        }),
    ));
  const params = (request: ProviderRequest) => {
    request.signal.throwIfAborted();
    const tools: Tool[] = [
      ...(request.tools.length
        ? [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: Object.fromEntries(
                  Object.entries(tool.parameters).filter(
                    ([key]) => key !== "$schema",
                  ),
                ),
              })),
            },
          ]
        : []),
      ...(settings.serverTools ?? []).map((name): Tool =>
        name === "web_search" ? { googleSearch: {} } : { codeExecution: {} },
      ),
    ];
    const config: GenerateContentConfig = {
      abortSignal: request.signal,
      systemInstruction: request.system,
      maxOutputTokens: settings.maxTokens,
      ...(settings.temperature !== undefined && {
        temperature: settings.temperature,
      }),
      ...(tools.length && { tools }),
      ...(settings.effort && {
        thinkingConfig: {
          thinkingLevel: (settings.effort === "low" ||
          settings.effort === "medium"
            ? settings.effort
            : "high"
          ).toUpperCase() as unknown as ThinkingLevel,
        },
      }),
    };
    return {
      model: settings.model,
      contents: toContents(request.messages),
      config,
    };
  };
  return {
    name: "gemini",
    capabilities: { toolCalling: true, vision: true, retries: true },
    async complete(request) {
      const response = await (
        await load()
      ).models.generateContent(params(request));
      request.signal.throwIfAborted();
      return toResult(completion([response]));
    },
    async *stream(request) {
      const chunks: GenerateContentResponse[] = [];
      for await (const chunk of await (
        await load()
      ).models.generateContentStream(params(request))) {
        chunks.push(chunk);
        for (const part of chunk.candidates?.[0]?.content?.parts ?? [])
          if (part.text && !part.thought)
            yield { type: "text", delta: part.text };
      }
      request.signal.throwIfAborted();
      if (!chunks.length) throw new Error("Empty model stream");
      return toResult(completion(chunks));
    },
  };
}
