import { abortable } from "./abort.js";
import type {
  Identity,
  ProviderAdapter,
  ReadTool,
  RunResult,
  Turn,
} from "./contracts.js";
export async function run(options: {
  provider: ProviderAdapter;
  tools: readonly ReadTool[];
  identity: Identity;
  input: string;
  system: string;
  signal: AbortSignal;
  maxRounds?: number;
  maxToolCalls?: number;
}): Promise<RunResult> {
  const { provider, signal } = options;
  const rounds = options.maxRounds ?? 8;
  const callLimit = options.maxToolCalls ?? 16;
  if (
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    !Number.isSafeInteger(callLimit) ||
    callLimit < 1
  )
    throw new Error("Invalid run limits");
  const identity = Object.freeze({ ...options.identity });
  const tools = new Map(options.tools.map((tool) => [tool.spec.name, tool]));
  if (tools.size !== options.tools.length)
    throw new Error("Duplicate tool names");
  const messages: Turn[] = [{ role: "user", content: options.input }];
  let calls = 0;
  const ids = new Set<string>();
  try {
    signal.throwIfAborted();
    const visible: ReadTool[] = [];
    for (const tool of tools.values())
      if (await abortable(() => tool.authorize(identity), signal))
        visible.push(tool);
    if (visible.length && !provider.capabilities.toolCalling)
      return { status: "failed", code: "unsupported" };
    for (let round = 0; round < rounds; round++) {
      signal.throwIfAborted();
      const result = await abortable(
        () =>
          provider.complete({
            system: options.system,
            messages: [...messages],
            tools: visible.map((tool) => tool.spec),
            signal,
          }),
        signal,
      );
      signal.throwIfAborted();
      if (result.finishReason === "length" || result.finishReason === "other")
        return { status: "failed", code: "invalid_response" };
      if (!result.toolCalls.length)
        return result.finishReason === "stop" && result.content.trim()
          ? { status: "completed", text: result.content }
          : { status: "failed", code: "invalid_response" };
      if (result.finishReason !== "tool_calls")
        return { status: "failed", code: "invalid_response" };
      if (calls + result.toolCalls.length > callLimit)
        return { status: "failed", code: "limit" };
      for (const call of result.toolCalls) {
        if (!call.id || ids.has(call.id))
          return { status: "failed", code: "invalid_response" };
        ids.add(call.id);
      }
      messages.push({
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
        ...(result.providerMetadata
          ? { providerMetadata: result.providerMetadata }
          : {}),
      });
      for (const call of result.toolCalls) {
        signal.throwIfAborted();
        const tool = visible.find((item) => item.spec.name === call.name);
        if (!tool || !(await abortable(() => tool.authorize(identity), signal)))
          return { status: "failed", code: "tool_denied" };
        signal.throwIfAborted();
        const content = await abortable(
          () => tool.execute(call.args, identity, signal),
          signal,
        );
        signal.throwIfAborted();
        if (content.length > 32_000)
          return { status: "failed", code: "invalid_response" };
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content,
        });
        calls++;
      }
    }
    return { status: "failed", code: "limit" };
  } catch {
    return signal.aborted
      ? { status: "cancelled" }
      : { status: "failed", code: "dependency_failed" };
  }
}
