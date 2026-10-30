import { z } from "zod";
import type { ProviderAdapter, ToolSpec } from "../core/contracts.js";

type Call = { id: string; name: string; args: Record<string, unknown> };
type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; toolCalls: Call[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };
export type TalonProviderRequest = {
  system: string;
  messages: Turn[];
  tools: ToolSpec[];
  signal: AbortSignal;
};
export type TalonProviderResult = {
  toolCalls: Call[];
  invalidToolCalls: { id: string; name: string }[];
  finishReason: "stop" | "tool_calls" | "length" | "other";
  usage?: { inputTokens: number; outputTokens: number };
};
export interface TalonProviderAdapter {
  name: string;
  capabilities: {
    toolCalling: boolean;
    contextTokens: number;
    streaming: boolean;
  };
  complete(request: TalonProviderRequest): Promise<TalonProviderResult>;
}

const configuration = z.strictObject({
  profile: z.string().min(1),
  contextTokens: z.number().int().positive(),
});
const argumentsSchema = z.record(z.string(), z.unknown());
const redundantMetadata = z.strictObject({
  function_call: z.undefined().optional(),
  tool_calls: z
    .array(
      z.strictObject({
        id: z.string(),
        type: z.literal("function"),
        function: z.strictObject({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
});
const usageSchema = z.object({
  usage: z
    .strictObject({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
    })
    .optional(),
});

export function createTalonProvider(
  provider: ProviderAdapter,
  options: { profile: string; contextTokens: number },
): TalonProviderAdapter {
  const { profile, contextTokens } = configuration.parse(options);
  if (!provider.capabilities.toolCalling)
    throw new Error("Talon requires tool calling");
  return {
    name: profile,
    capabilities: { toolCalling: true, contextTokens, streaming: false },
    async complete(request) {
      request.signal.throwIfAborted();
      const result = await provider.complete({
        ...request,
        messages: request.messages.map((turn) =>
          turn.role === "assistant" ? { ...turn, content: "" } : turn,
        ),
      });
      request.signal.throwIfAborted();
      if (
        result.providerMetadata &&
        (result.providerMetadata.provider !== provider.name ||
          !redundantMetadata.safeParse(result.providerMetadata.data).success)
      )
        throw new Error("Talon cannot retain provider continuation metadata");
      const toolCalls: Call[] = [];
      const invalidToolCalls: { id: string; name: string }[] = [];
      for (const call of result.toolCalls) {
        const id = z.string().min(1).parse(call.id);
        const name = z.string().min(1).parse(call.name);
        const parsed = argumentsSchema.safeParse(call.args);
        if (parsed.success) toolCalls.push({ id, name, args: parsed.data });
        else invalidToolCalls.push({ id, name });
      }
      const { usage } = usageSchema.parse(result);
      return {
        toolCalls,
        invalidToolCalls,
        finishReason: result.finishReason,
        ...(usage ? { usage } : {}),
      };
    },
  };
}
