import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import { chatModelAdapter } from "./langchain.js";
import { defined, modelOptions, thinking } from "./options.js";
export const anthropicOptions = modelOptions.extend({ thinking });
export function createAnthropicProvider(
  config: z.input<typeof anthropicOptions>,
) {
  const options = anthropicOptions.parse(config);
  return chatModelAdapter(
    "anthropic",
    new ChatAnthropic({
      apiKey: options.apiKey,
      model: options.model ?? "claude-haiku-5-5",
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      ...defined({
        temperature: options.temperature,
        anthropicApiUrl: options.baseUrl,
        clientOptions: options.headers && { defaultHeaders: options.headers },
        thinking: options.thinking && {
          type: "enabled" as const,
          budget_tokens: options.thinking.budgetTokens,
        },
      }),
    }),
  );
}
