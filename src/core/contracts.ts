import type { WriteTool, Suspension, Ask } from "./action.js";
import type { RunOptions } from "./runtime.js";
export type ProviderMetadata = Readonly<{
  provider: string;
  data: Record<string, unknown>;
}>;
export type ContentPart =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{
      type: "image";
      mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      data: string;
    }>;
export type Content = string | ContentPart[];
export type ToolCall = Readonly<{ id: string; name: string; args: unknown }>;
export type Turn =
  | Readonly<{ role: "user"; content: Content }>
  | Readonly<{
      role: "assistant";
      content: string;
      toolCalls: readonly ToolCall[];
      providerMetadata?: ProviderMetadata;
    }>
  | Readonly<{
      role: "tool";
      toolCallId: string;
      name: string;
      content: Content;
    }>;
export type ToolSpec = Readonly<{
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;
export type ProviderRequest = Readonly<{
  system: string;
  messages: readonly Turn[];
  tools: readonly ToolSpec[];
  signal: AbortSignal;
}>;
export type ProviderResult = Readonly<{
  usage?: Readonly<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }>;
  content: string;
  toolCalls: readonly ToolCall[];
  providerMetadata?: ProviderMetadata;
  finishReason: "stop" | "tool_calls" | "length" | "refusal" | "other";
}>;
export type ProviderDelta = Readonly<{ type: "text"; delta: string }>;
export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: Readonly<{ toolCalling: boolean; vision?: boolean }>;
  complete(request: ProviderRequest): Promise<ProviderResult>;
  stream?(
    request: ProviderRequest,
  ): AsyncGenerator<ProviderDelta, ProviderResult>;
}
export type Identity = Readonly<{ actorId: string; tenantId: string }>;
export interface ReadTool {
  readonly spec: ToolSpec;
  readonly effect: "read";
  authorize(identity: Identity): Promise<boolean>;
  execute(
    args: unknown,
    identity: Identity,
    signal: AbortSignal,
    run?: ToolRun,
  ): Promise<Content>;
}
export type ToolRun = Readonly<{
  ask?: Ask;
  addUsage: (usage: ProviderResult["usage"]) => void;
  maxOutput: number;
  runChild?: (options: RunOptions) => Promise<ChildRun>;
}>;
export type ChildRun = Readonly<{
  result: RunResult;
  usage: ProviderResult["usage"];
}>;
export type Tool = ReadTool | WriteTool;
export const failureCodes = [
  "limit",
  "unsupported",
  "invalid_response",
  "tool_denied",
  "dependency_failed",
  "refused",
  "timeout",
  "retry_exhausted",
] as const;
export type RunResult = TerminalResult | Suspension;
export type TerminalResult =
  | Readonly<{ status: "completed"; text: string }>
  | Readonly<{
      status: "failed";
      code: (typeof failureCodes)[number];
    }>
  | Readonly<{ status: "cancelled" }>;
