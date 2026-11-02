import { nativeAnthropicAdapter } from "./native/anthropic.js";
import { modelOptions, type ModelOptions } from "./options.js";
export function createAnthropicProvider(config: ModelOptions) {
  const options = modelOptions.parse(config);
  return nativeAnthropicAdapter({
    ...options,
    model: options.model ?? "claude-opus-5-5",
  });
}
