import { nativeOpenAIAdapter } from "./native/openai.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createDeepSeekProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return nativeOpenAIAdapter({
    ...options,
    name: "deepseek",
    model: options.model ?? "deepseek-flash",
    baseUrl: options.baseUrl ?? "https://api.deepseek.com",
    extraBody: { thinking: { type: "disabled" } },
  });
}
