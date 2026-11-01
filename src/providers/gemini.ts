import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { chatModelAdapter } from "./langchain.js";
import { defined, modelOptions, type ModelOptions } from "./options.js";
export function createGeminiProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return chatModelAdapter(
    "gemini",
    new ChatGoogleGenerativeAI({
      apiKey: options.apiKey,
      model: options.model ?? "gemini-3.8-flash",
      maxOutputTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      ...defined({
        temperature: options.temperature,
        baseUrl: options.baseUrl,
        customHeaders: options.headers,
      }),
    }),
    true,
  );
}
