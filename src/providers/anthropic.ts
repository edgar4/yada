import { ChatAnthropic } from "@langchain/anthropic";
import { chatModelAdapter } from "./langchain.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createAnthropicProvider(config: ModelOptions) {
  const { model, ...options } = modelOptions.parse(config);
  return chatModelAdapter(
    "anthropic",
    new ChatAnthropic({
      ...options,
      model: model ?? "claude-sonnet-4-6",
      maxRetries: 0,
    }),
  );
}
