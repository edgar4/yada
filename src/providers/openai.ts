import { ChatOpenAI } from "@langchain/openai";
import { chatModelAdapter } from "./langchain.js";
import { defined, modelOptions, type ModelOptions } from "./options.js";
export function openAIChat(
  name: string,
  options: {
    model: string;
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    headers?: Record<string, string> | undefined;
    maxTokens?: number | undefined;
    temperature?: number | undefined;
    maxRetries: number;
  },
  extra: Record<string, unknown> = {},
) {
  return chatModelAdapter(
    name,
    new ChatOpenAI({
      model: options.model,
      apiKey: options.apiKey ?? "unused",
      maxRetries: options.maxRetries,
      ...defined({
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      }),
      configuration: defined({
        baseURL: options.baseUrl,
        defaultHeaders: options.headers,
      }),
      useResponsesApi: false,
      ...extra,
    }),
  );
}
export function createOpenAIProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return openAIChat(
    "openai",
    { ...options, model: options.model ?? "gpt-6-luna" },
    options.model ? {} : { modelKwargs: { reasoning_effort: "none" } },
  );
}
