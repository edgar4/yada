import { z } from "zod";
import { nativeAnthropicAdapter } from "./native/anthropic.js";
import { effort, modelOptions, thinkingDisplay } from "./options.js";
const anthropicOptions = modelOptions
  .omit({ temperature: true })
  .extend({ effort, thinkingDisplay });
export function createAnthropicProvider(
  config: z.input<typeof anthropicOptions>,
) {
  const options = anthropicOptions.parse(config);
  return nativeAnthropicAdapter({
    ...options,
    model: options.model ?? "claude-opus-5-5",
  });
}
