import { limitsSchema, type RunLimits } from "./limits.js";
import type { ActionExecutor } from "./action.js";
import { abortable } from "./abort.js";
import {
  checkpointSchema,
  CheckpointError,
  type RunCheckpoint,
} from "./checkpoint.js";
import type {
  Identity,
  ProviderAdapter,
  Tool,
  TerminalResult,
  RunResult,
  Turn,
} from "./contracts.js";
export async function run(options: {
  provider: ProviderAdapter;
  tools: readonly Tool[];
  identity: Identity;
  input: string;
  system: string;
  signal: AbortSignal;
  history?: readonly Turn[];
  executeWrite?: ActionExecutor;
  limits?: RunLimits;
  maxRounds?: number;
  maxToolCalls?: number;
  checkpoint?: RunCheckpoint;
  persist?: (checkpoint: RunCheckpoint) => Promise<void>;
}): Promise<RunResult> {
  const { provider, signal } = options;
  const limits = limitsSchema.parse(options.limits ?? {});
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
  const state = checkpointSchema.parse(
    options.checkpoint ?? {
      version: 1,
      messages: [
        ...(options.history ?? []),
        { role: "user", content: options.input },
      ],
      pending: [],
      rounds: 0,
      calls: 0,
    },
  );
  const save = async () => {
    try {
      await options.persist?.(structuredClone(state));
    } catch {
      throw new CheckpointError();
    }
  };
  const finish = async (result: TerminalResult) => {
    state.outcome = result;
    await save();
    return result;
  };
  if (state.outcome) return state.outcome;
  const ids = new Set(
    state.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.toolCalls.map((call) => call.id)
        : [],
    ),
  );
  try {
    signal.throwIfAborted();
    const visible: Tool[] = [];
    for (const tool of tools.values())
      if (await abortable(() => tool.authorize(identity), signal))
        visible.push(tool);
    if (visible.length && !provider.capabilities.toolCalling)
      return await finish({ status: "failed", code: "unsupported" });
    for (;;) {
      for (const call of [...state.pending]) {
        signal.throwIfAborted();
        const tool = visible.find((item) => item.spec.name === call.name);
        if (!tool || !(await abortable(() => tool.authorize(identity), signal)))
          return await finish({ status: "failed", code: "tool_denied" });
        signal.throwIfAborted();
        if (tool.effect === "write" && !options.executeWrite)
          return await finish({ status: "failed", code: "unsupported" });
        const executeWrite = options.executeWrite;
        const content =
          tool.effect === "read"
            ? await abortable(
                () => tool.execute(call.args, identity, signal),
                signal,
              )
            : executeWrite
              ? await executeWrite(tool, call, signal)
              : "";
        if (typeof content !== "string") return content;
        signal.throwIfAborted();
        if (content.length > 32_000)
          return await finish({ status: "failed", code: "invalid_response" });
        state.messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content,
        });
        state.calls++;
        state.pending.shift();
        await save();
      }
      if (state.rounds >= rounds)
        return await finish({ status: "failed", code: "limit" });
      signal.throwIfAborted();
      const contextSize =
        options.system.length +
        JSON.stringify(state.messages).length +
        JSON.stringify(visible.map((tool) => tool.spec)).length;
      if (contextSize > limits.maxContextChars)
        return await finish({ status: "failed", code: "limit" });
      if (
        limits.maxCostMicros !== undefined &&
        limits.costPerCallMicros !== undefined
      ) {
        const reserved =
          (state.reservedCostMicros ?? 0) + limits.costPerCallMicros;
        if (reserved > limits.maxCostMicros)
          return await finish({ status: "failed", code: "limit" });
        state.reservedCostMicros = reserved;
      }
      state.rounds++;
      await save();
      const result = await abortable(
        () =>
          provider.complete({
            system: options.system,
            messages: structuredClone(state.messages),
            tools: visible.map((tool) => tool.spec),
            signal,
          }),
        signal,
      );
      signal.throwIfAborted();
      if (result.usage)
        state.usage = {
          inputTokens:
            (state.usage?.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens:
            (state.usage?.outputTokens ?? 0) + result.usage.outputTokens,
        };
      if (result.finishReason === "length" || result.finishReason === "other")
        return await finish({ status: "failed", code: "invalid_response" });
      if (!result.toolCalls.length)
        return await finish(
          result.finishReason === "stop" && result.content.trim()
            ? { status: "completed", text: result.content }
            : { status: "failed", code: "invalid_response" },
        );
      if (result.finishReason !== "tool_calls")
        return await finish({ status: "failed", code: "invalid_response" });
      if (state.calls + result.toolCalls.length > callLimit)
        return await finish({ status: "failed", code: "limit" });
      for (const call of result.toolCalls) {
        if (!call.id || ids.has(call.id))
          return await finish({ status: "failed", code: "invalid_response" });
        ids.add(call.id);
      }
      state.messages.push({
        role: "assistant",
        content: result.content,
        toolCalls: [...result.toolCalls],
        ...(result.providerMetadata
          ? { providerMetadata: result.providerMetadata }
          : {}),
      });
      state.pending = [...result.toolCalls];
      await save();
    }
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    return finish(
      signal.aborted
        ? { status: "cancelled" }
        : { status: "failed", code: "dependency_failed" },
    );
  }
}
