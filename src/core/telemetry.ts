import type { RunHooks } from "./hooks.js";
type Attribute = string | number | boolean;
export interface Span {
  setAttribute(key: string, value: Attribute): void;
  setStatus(status: { code: "ok" | "error" }): void;
  end(): void;
}
export interface Tracer {
  startSpan(
    name: string,
    attributes?: Record<string, Attribute>,
    parent?: Span,
  ): Span;
}
const errorCodes = new Set([
  "unknown_tool",
  "denied",
  "invalid_arguments",
  "tool_failed",
]);
const category = (content: string) => {
  try {
    const { error } = JSON.parse(content) as { error?: unknown };
    return typeof error === "string" && errorCodes.has(error) ? error : "error";
  } catch {
    return "error";
  }
};
export function tracingHooks(
  tracer: Tracer,
  info: { provider?: string; model?: string } = {},
): RunHooks {
  let run: Span | undefined;
  let model: Span | undefined;
  const tools = new Map<string, Span>();
  const root = () => (run ??= tracer.startSpan("yada.run"));
  const tool = (id: string, name: string) => {
    let span = tools.get(id);
    if (!span) {
      span = tracer.startSpan("yada.tool", { "tool.name": name }, root());
      tools.set(id, span);
    }
    return span;
  };
  const close = (span: Span, ok: boolean) => {
    span.setStatus({ code: ok ? "ok" : "error" });
    span.end();
  };
  return {
    beforeModel() {
      model = tracer.startSpan(
        "yada.model",
        {
          ...(info.provider ? { "model.provider": info.provider } : {}),
          ...(info.model ? { "model.name": info.model } : {}),
        },
        root(),
      );
      return undefined;
    },
    afterModel(result) {
      if (!model) return undefined;
      model.setAttribute("model.finish_reason", result.finishReason);
      if (result.usage) {
        model.setAttribute("usage.input_tokens", result.usage.inputTokens);
        model.setAttribute("usage.output_tokens", result.usage.outputTokens);
        if (result.usage.cacheReadTokens !== undefined)
          model.setAttribute(
            "usage.cache_read_tokens",
            result.usage.cacheReadTokens,
          );
        if (result.usage.cacheWriteTokens !== undefined)
          model.setAttribute(
            "usage.cache_write_tokens",
            result.usage.cacheWriteTokens,
          );
        if (result.usage.serverToolCalls !== undefined)
          model.setAttribute(
            "usage.server_tool_calls",
            result.usage.serverToolCalls,
          );
      }
      close(model, true);
      model = undefined;
      return undefined;
    },
    beforeTool(call, definition) {
      tool(call.id, call.name).setAttribute("tool.effect", definition.effect);
      return undefined;
    },
    onEvent(event) {
      if (event.type === "tool_started") tool(event.call.id, event.call.name);
      else if (event.type === "tool_finished") {
        const span = tool(event.call.id, event.call.name);
        span.setAttribute(
          "tool.outcome",
          event.failed ? category(event.content) : "ok",
        );
        close(span, !event.failed);
        tools.delete(event.call.id);
      } else if (
        event.type === "run_finished" ||
        event.type === "run_suspended"
      ) {
        const ok = event.type === "run_suspended";
        if (model) close(model, ok);
        for (const span of tools.values()) close(span, ok);
        model = undefined;
        tools.clear();
        const span = root();
        span.setAttribute("run.status", event.result.status);
        if (event.result.status === "failed")
          span.setAttribute("run.code", event.result.code);
        close(span, ok || event.result.status === "completed");
        run = undefined;
      }
      return undefined;
    },
  };
}
