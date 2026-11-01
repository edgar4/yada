import { chatModelAdapter } from "./langchain.js";
import { optionalImport } from "../optional.js";
import { defined, modelOptions, type ModelOptions } from "./options.js";
const supportsVision = true;
export function createGeminiProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return chatModelAdapter(
    "gemini",
    async () => {
      const { ChatGoogleGenerativeAI } = await optionalImport(
        () => import("@langchain/google-genai"),
        "@langchain/google-genai @langchain/core",
        "The Gemini provider",
      );
      return new ChatGoogleGenerativeAI({
        apiKey: options.apiKey,
        model: options.model ?? "gemini-3.8-flash",
        maxOutputTokens: options.maxTokens,
        maxRetries: options.maxRetries,
        ...defined({
          temperature: options.temperature,
          baseUrl: options.baseUrl,
          customHeaders: options.headers,
        }),
      });
    },
    supportsVision,
  );
}
