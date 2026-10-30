import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { chatModelAdapter } from "./langchain.js";
export const localOptions = z.strictObject({
  provider: z.enum(["ollama", "llamacpp"]),
  model: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    })
    .optional(),
});
export function createLocalProvider(config: z.input<typeof localOptions>) {
  const options = localOptions.parse(config);
  return chatModelAdapter(
    options.provider,
    new ChatOpenAI({
      model: options.model,
      apiKey: options.apiKey ?? "local",
      configuration: {
        baseURL:
          options.baseUrl ??
          (options.provider === "ollama"
            ? "http://localhost:11434/v1"
            : "http://localhost:8080/v1"),
      },
      maxRetries: 0,
      useResponsesApi: false,
    }),
  );
}
