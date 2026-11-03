import { nativeAnthropicAdapter } from "./native/anthropic.js";
import { parseModelOptions, type ModelOptions } from "./options.js";
export function createAnthropicProvider(config: ModelOptions) {
  const options = parseModelOptions(config, true);
  return nativeAnthropicAdapter({
    ...options,
    model: options.model ?? "claude-opus-5-5",
    serverTools: options.serverTools ?? ["web_search"],
  });
}
