import { nativeOpenAIAdapter } from "./native/openai.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createOpenAIProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return nativeOpenAIAdapter({
    ...options,
    name: "openai",
    model: options.model ?? "gpt-6-luna",
    vision: true,
    maxTokensParam: "max_completion_tokens",
    ...(!options.model && { extraBody: { reasoning_effort: "none" } }),
  });
}
