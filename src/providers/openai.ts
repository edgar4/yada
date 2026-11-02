import { nativeOpenAIResponsesAdapter } from "./native/openai-responses.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createOpenAIProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return nativeOpenAIResponsesAdapter({
    ...options,
    name: "openai",
    model: options.model ?? "gpt-6-luna",
    serverTools: options.serverTools ?? ["web_search"],
    vision: true,
    effort: options.effort ?? (options.model ? undefined : "none"),
  });
}
