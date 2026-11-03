import { nativeOpenAIResponsesAdapter } from "./native/openai-responses.js";
import { parseModelOptions, type ModelOptions } from "./options.js";
export function createOpenAIProvider(config: ModelOptions) {
  const options = parseModelOptions(config, true);
  return nativeOpenAIResponsesAdapter({
    ...options,
    name: "openai",
    model: options.model ?? "gpt-6-luna",
    serverTools: options.serverTools ?? ["web_search"],
    vision: true,
    effort: options.effort ?? (options.model ? undefined : "none"),
  });
}
