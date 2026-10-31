import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import { chatModelAdapter } from "./langchain.js";
import { defined, effort, modelOptions, thinkingDisplay } from "./options.js";
export const anthropicOptions = modelOptions
  .omit({ temperature: true })
  .extend({ effort, thinkingDisplay });
export function createAnthropicProvider(
  config: z.input<typeof anthropicOptions>,
) {
  const options = anthropicOptions.parse(config);
  return chatModelAdapter(
    "anthropic",
    new ChatAnthropic({
      apiKey: options.apiKey,
      model: options.model ?? "claude-opus-5-5",
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      ...defined({
        anthropicApiUrl: options.baseUrl,
        clientOptions: options.headers && { defaultHeaders: options.headers },
        outputConfig: options.effort && { effort: options.effort },
        thinking: options.thinkingDisplay && {
          type: "adaptive" as const,
          display: options.thinkingDisplay,
        },
      }),
    }),
  );
}
