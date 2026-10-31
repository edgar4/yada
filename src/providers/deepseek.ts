import { openAIChat } from "./openai.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createDeepSeekProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return openAIChat(
    "deepseek",
    {
      ...options,
      model: options.model ?? "deepseek-flash",
      baseUrl: options.baseUrl ?? "https://api.deepseek.com",
    },
    { modelKwargs: { thinking: { type: "disabled" } } },
  );
}
