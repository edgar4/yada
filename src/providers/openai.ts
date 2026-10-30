import { ChatOpenAI } from "@langchain/openai";
import { chatModelAdapter } from "./langchain.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createOpenAIProvider(config: ModelOptions) {
  const { model, ...options } = modelOptions.parse(config);
  return chatModelAdapter(
    "openai",
    new ChatOpenAI({
      ...options,
      model: model ?? "gpt-4.1-mini",
      maxRetries: 0,
      useResponsesApi: false,
    }),
  );
}
