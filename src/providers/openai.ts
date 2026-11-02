import { z } from "zod";
import { nativeOpenAIAdapter } from "./native/openai.js";
import { nativeOpenAIResponsesAdapter } from "./native/openai-responses.js";
import { effort, modelOptions, openaiApi } from "./options.js";
const openaiOptions = modelOptions.extend({ effort, api: openaiApi });
export function createOpenAIProvider(config: z.input<typeof openaiOptions>) {
  const { api, ...options } = openaiOptions.parse(config);
  const settings = {
    ...options,
    name: "openai",
    model: options.model ?? "gpt-6-luna",
    vision: true,
  };
  const defaultEffort = options.effort ?? (options.model ? undefined : "none");
  return api === "chat"
    ? nativeOpenAIAdapter({
        ...settings,
        maxTokensParam: "max_completion_tokens",
        ...(defaultEffort && {
          extraBody: { reasoning_effort: defaultEffort },
        }),
      })
    : nativeOpenAIResponsesAdapter({ ...settings, effort: defaultEffort });
}
