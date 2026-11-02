import { nativeGeminiAdapter } from "./native/gemini.js";
import { requirePackage } from "../optional.js";
import { parseModelOptions, type ModelOptions } from "./options.js";
export function createGeminiProvider(config: ModelOptions) {
  const options = parseModelOptions(config, true);
  requirePackage("@google/genai", "The Gemini provider");
  return nativeGeminiAdapter({
    ...options,
    model: options.model ?? "gemini-3.8-flash",
    serverTools: options.serverTools ?? ["web_search"],
  });
}
