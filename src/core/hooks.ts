import type { Suspension } from "./action.js";
import type {
  ProviderRequest,
  ProviderResult,
  TerminalResult,
  Tool,
  ToolCall,
} from "./contracts.js";
export type AgentEvent =
  | Readonly<{ type: "round_started"; round: number }>
  | Readonly<{ type: "text_delta"; delta: string }>
  | Readonly<{ type: "tool_started"; call: ToolCall }>
  | Readonly<{
      type: "tool_finished";
      call: ToolCall;
      content: string;
      failed: boolean;
      cause?: string;
    }>
  | Readonly<{ type: "steering_unconsumed"; count: number }>
  | Readonly<{
      type: "model_finished";
      purpose?: "summary";
      usage?: ProviderResult["usage"];
      finishReason: ProviderResult["finishReason"];
    }>
  | Readonly<{ type: "run_finished"; result: TerminalResult; cause?: string }>
  | Readonly<{ type: "run_suspended"; result: Suspension }>;
export type ModelCall = Readonly<{ purpose?: "summary" }>;
export type RunHooks = Readonly<{
  beforeModel?(
    request: ProviderRequest,
    call?: ModelCall,
  ): Promise<ProviderRequest | undefined> | ProviderRequest | undefined;
  afterModel?(
    result: ProviderResult,
    call?: ModelCall,
  ): Promise<void> | undefined;
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
export function composeHooks(...hooks: readonly RunHooks[]): RunHooks {
  return {
    async beforeModel(request, call) {
      let current = request;
      for (const hook of hooks)
        current = (await hook.beforeModel?.(current, call)) ?? current;
      return current === request ? undefined : current;
    },
    async afterModel(result, call) {
      for (const hook of hooks) await hook.afterModel?.(result, call);
    },
    async beforeTool(call, tool) {
      for (const hook of hooks) {
        const verdict = await hook.beforeTool?.(call, tool);
        if (verdict?.deny !== undefined) return verdict;
      }
      return undefined;
    },
    async afterTool(call, content) {
      let current = content;
      for (const hook of hooks)
        current = (await hook.afterTool?.(call, current)) ?? current;
      return current === content ? undefined : current;
    },
    async onEvent(event) {
      for (const hook of hooks)
        await Promise.resolve()
          .then(() => hook.onEvent?.(event))
          .catch(() => undefined);
    },
  };
}
