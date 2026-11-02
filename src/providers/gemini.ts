import { nativeGeminiAdapter } from "./native/gemini.js";
import { effort, modelOptions } from "./options.js";
import type { z } from "zod";
const geminiOptions = modelOptions.extend({ effort });
export function createGeminiProvider(config: z.input<typeof geminiOptions>) {
  const options = geminiOptions.parse(config);
  return nativeGeminiAdapter({
    ...options,
    model: options.model ?? "gemini-3.8-flash",
  });
}
