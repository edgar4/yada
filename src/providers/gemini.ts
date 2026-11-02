import { nativeGeminiAdapter } from "./native/gemini.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createGeminiProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return nativeGeminiAdapter({
    ...options,
    model: options.model ?? "gemini-3.8-flash",
    serverTools: options.serverTools ?? ["web_search"],
  });
}
