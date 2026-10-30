import { ChatOpenAI } from "@langchain/openai";
import { chatModelAdapter } from "./langchain.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createDeepSeekProvider(config: ModelOptions) {
  const { model, ...options } = modelOptions.parse(config);
  return chatModelAdapter(
    "deepseek",
    new ChatOpenAI({
      ...options,
      model: model ?? "deepseek-flash",
      configuration: { baseURL: "https://api.deepseek.com" },
      modelKwargs: { thinking: { type: "disabled" } },
      maxRetries: 0,
      useResponsesApi: false,
    }),
  );
}
