import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { chatModelAdapter } from "./langchain.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createGeminiProvider(config: ModelOptions) {
  const { model, maxTokens, ...options } = modelOptions.parse(config);
  return chatModelAdapter(
    "gemini",
    new ChatGoogleGenerativeAI({
      ...options,
      model: model ?? "gemini-3.8-flash",
      maxOutputTokens: maxTokens,
      maxRetries: 0,
    }),
  );
}
