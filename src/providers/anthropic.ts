import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import { chatModelAdapter } from "./langchain.js";
const configSchema = z.strictObject({
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1),
  maxTokens: z.number().int().positive().default(1024),
});
export function createAnthropicProvider(config: z.input<typeof configSchema>) {
  const options = configSchema.parse(config);
  return chatModelAdapter(
    "anthropic",
    new ChatAnthropic({ ...options, maxRetries: 0 }),
  );
}
