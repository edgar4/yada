export type ToolCall = Readonly<{ id: string; name: string; args: unknown }>;
export type Turn =
  | Readonly<{ role: "user"; content: string }>
  | Readonly<{
      role: "assistant";
      content: string;
      toolCalls: readonly ToolCall[];
    }>
  | Readonly<{
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
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
  content: string;
  toolCalls: readonly ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "other";
}>;
export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: Readonly<{ toolCalling: boolean }>;
  complete(request: ProviderRequest): Promise<ProviderResult>;
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
  ): Promise<string>;
}
export type RunResult =
  | Readonly<{ status: "completed"; text: string }>
  | Readonly<{
      status: "failed";
      code:
        | "limit"
        | "unsupported"
        | "invalid_response"
        | "tool_denied"
        | "dependency_failed";
    }>
  | Readonly<{ status: "cancelled" }>;
