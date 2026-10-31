import type {
  ProviderRequest,
  ProviderResult,
  TerminalResult,
  Tool,
  ToolCall,
} from "./contracts.js";
export type AgentEvent =
  | Readonly<{ type: "round_started"; round: number }>
  | Readonly<{ type: "tool_started"; call: ToolCall }>
  | Readonly<{
      type: "tool_finished";
      call: ToolCall;
      content: string;
      failed: boolean;
    }>
  | Readonly<{
      type: "model_finished";
      usage?: ProviderResult["usage"];
      finishReason: ProviderResult["finishReason"];
    }>
  | Readonly<{ type: "run_finished"; result: TerminalResult }>;
export type RunHooks = Readonly<{
  beforeModel?(
    request: ProviderRequest,
  ): Promise<ProviderRequest | undefined> | ProviderRequest | undefined;
  afterModel?(result: ProviderResult): Promise<void> | undefined;
  beforeTool?(
    call: ToolCall,
    tool: Tool,
  ): Promise<{ deny?: string } | undefined> | { deny?: string } | undefined;
  afterTool?(
    call: ToolCall,
    content: string,
  ): Promise<string | undefined> | string | undefined;
  onEvent?(event: AgentEvent): Promise<void> | undefined;
}>;
