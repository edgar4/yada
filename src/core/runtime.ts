import { compactOldest, limitsSchema, type RunLimits } from "./limits.js";
import { Suspended, type ActionExecutor } from "./action.js";
import type { AgentEvent, RunHooks } from "./hooks.js";
import { abortable } from "./abort.js";
import { contentText, hasImages, mapText } from "./content.js";
import { InvalidArguments } from "./tool.js";
import {
  checkpointSchema,
  CheckpointError,
  type RunCheckpoint,
} from "./checkpoint.js";
import type {
  ChildRun,
  Content,
  Identity,
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  Tool,
  ToolCall,
  TerminalResult,
  RunResult,
  Turn,
} from "./contracts.js";
const toolError = (error: string, message: string) =>
  JSON.stringify({ error, message });
const summaryPrefix = "[summary of earlier conversation]\n";
const summarySystem =
  "Summarize this conversation for an assistant that will continue it. Keep the facts, decisions, tool results and open questions it still needs. Reply with the summary only.";
export type SummarizeOptions = Readonly<{
  provider?: ProviderAdapter;
  keepTurns?: number;
}>;
export const runTurns = (messages: readonly Turn[], steered = 0) =>
  messages.slice(
    messages
      .flatMap((turn, index) => (turn.role === "user" ? [index] : []))
      .at(-(steered + 1)) ?? 0,
  );
export type RunOptions = {
  provider: ProviderAdapter;
  tools: readonly Tool[];
  identity: Identity;
  input: Content;
  system: string;
  signal: AbortSignal;
  history?: readonly Turn[];
  executeWrite?: ActionExecutor;
  limits?: RunLimits;
  maxRounds?: number;
  maxToolCalls?: number;
  checkpoint?: RunCheckpoint;
  drainSteering?: () => Promise<readonly { id: string; content: Content }[]>;
  persist?: (checkpoint: RunCheckpoint) => Promise<void>;
  hooks?: RunHooks;
  summarize?: SummarizeOptions;
  nest?: (call: ToolCall, child: RunOptions) => Promise<ChildRun>;
};
type Loop = {
  options: RunOptions;
  signal: AbortSignal;
  identity: Identity;
  limits: ReturnType<typeof limitsSchema.parse>;
  maxRounds: number;
  maxToolCalls: number;
  tools: Map<string, Tool>;
  visible: Tool[];
  state: RunCheckpoint;
  ids: Set<string>;
  fresh: Set<string>;
  save: () => Promise<void>;
  finish: (result: TerminalResult) => Promise<RunResult>;
  emit: (event: AgentEvent) => void;
};
type ToolOutcome =
  | { content: Content; failed: boolean }
  | { stop: RunResult }
  | { terminal: TerminalResult };
const emitTo = (hooks: RunHooks | undefined, event: AgentEvent) => {
  void Promise.resolve()
    .then(() => hooks?.onEvent?.(event))
    .catch(() => undefined);
};
export async function run(options: RunOptions): Promise<RunResult> {
  const result = await runLoop(options);
  if (result.status === "awaiting_approval" || result.status === "reconciling")
    emitTo(options.hooks, { type: "run_suspended", result });
  return result;
}
async function runLoop(options: RunOptions): Promise<RunResult> {
  const { provider, signal, hooks } = options;
  const limits = limitsSchema.parse(options.limits ?? {});
  const maxRounds = options.maxRounds ?? limits.maxRounds;
  const maxToolCalls = options.maxToolCalls ?? limits.maxToolCalls;
  if (
    !Number.isSafeInteger(maxRounds) ||
    maxRounds < 1 ||
    !Number.isSafeInteger(maxToolCalls) ||
    maxToolCalls < 1
  )
    throw new Error("Invalid run limits");
  const keepTurns = options.summarize?.keepTurns;
  if (
    keepTurns !== undefined &&
    (!Number.isSafeInteger(keepTurns) || keepTurns < 1)
  )
    throw new Error("Invalid summarize options");
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
  const emit = (event: AgentEvent) => {
    emitTo(hooks, event);
  };
  const finish = async (result: TerminalResult): Promise<RunResult> => {
    try {
      for (const call of state.pending) {
        const unresolved = await options.executeWrite?.unresolved?.(call);
        if (unresolved) return unresolved;
      }
    } catch {
      throw new CheckpointError();
    }
    state.outcome = result;
    await save();
    emit({ type: "run_finished", result });
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
  const loop: Loop = {
    options,
    signal,
    identity,
    limits,
    maxRounds,
    maxToolCalls,
    tools,
    visible: [],
    state,
    ids,
    fresh: new Set(),
    save,
    finish,
    emit,
  };
  try {
    signal.throwIfAborted();
    for (const tool of tools.values())
      if (await abortable(() => tool.authorize(identity), signal))
        loop.visible.push(tool);
    if (loop.visible.length && !provider.capabilities.toolCalling)
      return await finish({ status: "failed", code: "unsupported" });
    for (;;) {
      if ((state.failures ?? 0) >= limits.maxFailures)
        return await finish({ status: "failed", code: "dependency_failed" });
      if (
        !provider.capabilities.vision &&
        state.messages.some((turn) => hasImages(turn.content))
      )
        return await finish({ status: "failed", code: "unsupported" });
      const stopped = await executePending(loop);
      if (stopped) return stopped;
      const unsupported = await drainSteering(loop);
      if (unsupported) return unsupported;
      const exceeded = await checkLimits(loop);
      if (exceeded) return exceeded;
      const result = await callModel(loop);
      const ended = await classify(loop, result);
      if (ended) return ended;
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
async function drainSteering(loop: Loop): Promise<RunResult | undefined> {
  const { state, options } = loop;
  if (!options.drainSteering) return undefined;
  let drained: Awaited<ReturnType<NonNullable<RunOptions["drainSteering"]>>>;
  try {
    drained = await options.drainSteering();
  } catch {
    throw new CheckpointError();
  }
  const fresh = drained.filter((item) => !state.steered?.includes(item.id));
  if (!fresh.length) return undefined;
  if (
    !options.provider.capabilities.vision &&
    fresh.some((item) => hasImages(item.content))
  )
    return loop.finish({ status: "failed", code: "unsupported" });
  for (const { id, content } of fresh) {
    state.messages.push({ role: "user", content });
    state.steered = [...(state.steered ?? []), id];
  }
  await loop.save();
  return undefined;
}
async function executePending(loop: Loop): Promise<RunResult | undefined> {
  const { state } = loop;
  const isRead = (call: ToolCall) =>
    loop.tools.get(call.name)?.effect !== "write";
  while (state.pending.length) {
    const first = state.pending[0];
    if (!first) break;
    const read = isRead(first);
    const group = [first];
    for (const call of state.pending.slice(1)) {
      if (!read || !isRead(call)) break;
      group.push(call);
    }
    const stopped = await executeGroup(
      loop,
      group,
      read ? loop.limits.maxParallelTools : 1,
    );
    if (stopped) return stopped;
  }
  return undefined;
}
async function executeGroup(
  loop: Loop,
  group: readonly ToolCall[],
  concurrency: number,
): Promise<RunResult | undefined> {
  const { state, limits } = loop;
  const abort = new AbortController();
  const forward = () => {
    abort.abort(loop.signal.reason);
  };
  loop.signal.addEventListener("abort", forward);
  const inner = group.length > 1 ? { ...loop, signal: abort.signal } : loop;
  const slots = group.map(() => {
    const slot = {} as {
      promise: Promise<ToolOutcome>;
      resolve: (outcome: ToolOutcome) => void;
      reject: (error: unknown) => void;
    };
    slot.promise = new Promise((resolve, reject) => {
      slot.resolve = resolve;
      slot.reject = reject;
    });
    return slot;
  });
  for (const slot of slots) slot.promise.catch(() => undefined);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < group.length; index = next++) {
      const call = group[index];
      const slot = slots[index];
      if (!call || !slot) return;
      try {
        inner.signal.throwIfAborted();
        loop.emit({ type: "tool_started", call });
        const outcome = await executeCall(inner, call);
        if (!("content" in outcome)) {
          slot.resolve(outcome);
          continue;
        }
        const content = await shapeOutput(inner, call, outcome.content);
        slot.resolve({ content, failed: outcome.failed });
      } catch (error) {
        slot.reject(error);
      }
    }
  };
  try {
    for (let n = Math.min(concurrency, group.length); n > 0; n--) void worker();
    for (const [index, call] of group.entries()) {
      const outcome = await slots[index]?.promise;
      if (!outcome) break;
      loop.signal.throwIfAborted();
      if ("stop" in outcome) return outcome.stop;
      if ("terminal" in outcome) return await loop.finish(outcome.terminal);
      const { content, failed } = outcome;
      state.messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content,
      });
      state.calls++;
      state.failures = failed ? (state.failures ?? 0) + 1 : 0;
      state.pending.shift();
      await loop.save();
      loop.emit({
        type: "tool_finished",
        call,
        content: contentText(content),
        failed,
      });
      if (state.failures >= limits.maxFailures)
        return await loop.finish({
          status: "failed",
          code: "dependency_failed",
        });
    }
    return undefined;
  } finally {
    abort.abort();
    loop.signal.removeEventListener("abort", forward);
  }
}
async function shapeOutput(
  loop: Loop,
  call: ToolCall,
  content: Content,
): Promise<Content> {
  const hook = loop.options.hooks?.afterTool;
  if (hook)
    content = await mapText(
      content,
      async (text) => (await hook(call, text)) ?? text,
    );
  loop.signal.throwIfAborted();
  const { maxToolOutput } = loop.limits;
  content = await mapText(content, (text) =>
    text.length > maxToolOutput
      ? `${text.slice(0, maxToolOutput)}…[truncated ${String(text.length - maxToolOutput)} chars]`
      : text,
  );
  return loop.options.provider.capabilities.vision
    ? content
    : contentText(content);
}
async function executeCall(loop: Loop, call: ToolCall): Promise<ToolOutcome> {
  const { options, signal, identity } = loop;
  const { nest } = options;
  const stop = (result: TerminalResult) => ({ terminal: result });
  const tool = loop.visible.find((item) => item.spec.name === call.name);
  if (!tool && loop.tools.has(call.name) && !loop.fresh.has(call.id))
    return stop({ status: "failed", code: "tool_denied" });
  if (!tool)
    return {
      failed: true,
      content: toolError(
        "unknown_tool",
        `Tool "${call.name}" is not available`,
      ),
    };
  if (!(await abortable(() => tool.authorize(identity), signal)))
    return stop({ status: "failed", code: "tool_denied" });
  signal.throwIfAborted();
  if (tool.effect === "write" && !options.executeWrite)
    return stop({ status: "failed", code: "unsupported" });
  const verdict = await options.hooks?.beforeTool?.(call, tool);
  if (verdict?.deny !== undefined)
    return { failed: true, content: toolError("denied", verdict.deny) };
  if (tool.effect === "write") {
    const content = await options.executeWrite?.(tool, call, signal);
    if (content === undefined) return { failed: false, content: "" };
    return typeof content === "string"
      ? { failed: false, content }
      : { stop: content };
  }
  try {
    return {
      failed: false,
      content: await abortable(
        () =>
          tool.execute(call.args, identity, signal, {
            addUsage: (usage) => {
              addUsage(loop.state, usage);
            },
            maxOutput: loop.limits.maxToolOutput,
            ...(nest ? { runChild: (child) => nest(call, child) } : {}),
            ...(options.executeWrite?.ask
              ? { ask: options.executeWrite.ask(call) }
              : {}),
          }),
        signal,
      ),
    };
  } catch (error) {
    if (error instanceof Suspended) return { stop: error.suspension };
    if (error instanceof CheckpointError) throw error;
    signal.throwIfAborted();
    return {
      failed: true,
      content:
        error instanceof InvalidArguments
          ? toolError("invalid_arguments", error.message)
          : toolError("tool_failed", "The tool failed"),
    };
  }
}
async function checkLimits(loop: Loop): Promise<RunResult | undefined> {
  const { state, limits, options } = loop;
  const exceeded = () => loop.finish({ status: "failed", code: "limit" });
  if (state.rounds >= loop.maxRounds) return exceeded();
  loop.signal.throwIfAborted();
  const size = () =>
    options.system.length +
    JSON.stringify(state.messages).length +
    JSON.stringify(loop.visible.map((tool) => tool.spec)).length;
  let contextSize = size();
  if (contextSize > limits.maxContextChars)
    contextSize -= compactOldest(
      state.messages,
      contextSize - limits.maxContextChars,
    );
  if (contextSize > limits.maxContextChars && options.summarize) {
    const stopped = await summarize(loop);
    if (stopped) return stopped;
    contextSize = size();
  }
  if (contextSize > limits.maxContextChars) return exceeded();
  if (limits.maxCostMicros !== undefined && limits.pricing && state.usage) {
    const { inputMicrosPer1k, outputMicrosPer1k } = limits.pricing;
    const { cacheReadTokens = 0, cacheWriteTokens = 0 } = state.usage;
    const spent =
      ((state.usage.inputTokens - cacheReadTokens - cacheWriteTokens) *
        inputMicrosPer1k +
        cacheReadTokens *
          (limits.pricing.cacheReadMicrosPer1k ?? inputMicrosPer1k) +
        cacheWriteTokens *
          (limits.pricing.cacheWriteMicrosPer1k ?? inputMicrosPer1k) +
        state.usage.outputTokens * outputMicrosPer1k) /
      1000;
    if (spent >= limits.maxCostMicros) return exceeded();
  }
  if (
    limits.maxCostMicros !== undefined &&
    limits.costPerCallMicros !== undefined
  ) {
    const reserved = (state.reservedCostMicros ?? 0) + limits.costPerCallMicros;
    if (reserved > limits.maxCostMicros) return exceeded();
    state.reservedCostMicros = reserved;
  }
  return undefined;
}
function addUsage(state: RunCheckpoint, usage: ProviderResult["usage"]) {
  if (!usage) return;
  const total = { ...state.usage };
  for (const [key, value] of Object.entries(usage))
    total[key as keyof typeof total] =
      (total[key as keyof typeof total] ?? 0) + value;
  state.usage = total as NonNullable<RunCheckpoint["usage"]>;
}
const transcriptLine = (turn: Turn) =>
  turn.role === "assistant"
    ? `assistant: ${[
        turn.content,
        ...turn.toolCalls.map(
          (call) => `[called ${call.name} ${JSON.stringify(call.args)}]`,
        ),
      ]
        .filter(Boolean)
        .join("\n")}`
    : `${turn.role === "tool" ? `tool ${turn.name}` : "user"}: ${contentText(turn.content)}`;
async function summarize(loop: Loop): Promise<RunResult | undefined> {
  const { state, signal, options } = loop;
  const users = state.messages.flatMap((turn, index) =>
    turn.role === "user" ? [index] : [],
  );
  const split = Math.min(
    users.at(-(options.summarize?.keepTurns ?? 2)) ?? 0,
    users.at(-((state.steered?.length ?? 0) + 1)) ?? 0,
  );
  const first = state.messages[0];
  const summarized =
    first?.role === "user" &&
    typeof first.content === "string" &&
    first.content.startsWith(summaryPrefix);
  if (split < (summarized ? 2 : 1)) return undefined;
  const provider = options.summarize?.provider ?? options.provider;
  const result = await abortable(
    () =>
      provider.complete({
        system: summarySystem,
        messages: [
          {
            role: "user",
            content: state.messages
              .slice(0, split)
              .map(transcriptLine)
              .join("\n\n"),
          },
        ],
        tools: [],
        signal,
      }),
    signal,
  );
  signal.throwIfAborted();
  addUsage(state, result.usage);
  loop.emit({
    type: "model_finished",
    purpose: "summary",
    ...(result.usage ? { usage: result.usage } : {}),
    finishReason: result.finishReason,
  });
  if (result.finishReason === "refusal")
    return loop.finish({ status: "failed", code: "refused" });
  if (result.finishReason !== "stop" || !result.content.trim())
    return loop.finish({ status: "failed", code: "invalid_response" });
  state.messages.splice(0, split, {
    role: "user",
    content: summaryPrefix + result.content,
  });
  await loop.save();
  return undefined;
}
async function callModel(loop: Loop): Promise<ProviderResult> {
  const { state, signal, options } = loop;
  state.rounds++;
  await loop.save();
  loop.emit({ type: "round_started", round: state.rounds });
  let request: ProviderRequest = {
    system: options.system,
    messages: structuredClone(state.messages),
    tools: loop.visible.map((tool) => tool.spec),
    signal,
  };
  const edited = await options.hooks?.beforeModel?.(request);
  if (edited) request = { ...edited, signal };
  const { provider, hooks } = options;
  let result: ProviderResult;
  if (provider.stream && hooks?.onEvent) {
    const chunks = provider.stream(request);
    for (;;) {
      const next = await abortable(() => chunks.next(), signal);
      if (next.done) {
        result = next.value;
        break;
      }
      loop.emit({ type: "text_delta", delta: next.value.delta });
    }
  } else result = await abortable(() => provider.complete(request), signal);
  signal.throwIfAborted();
  addUsage(state, result.usage);
  await options.hooks?.afterModel?.(result);
  loop.emit({
    type: "model_finished",
    ...(result.usage ? { usage: result.usage } : {}),
    finishReason: result.finishReason,
  });
  return result;
}
async function classify(
  loop: Loop,
  result: ProviderResult,
): Promise<RunResult | undefined> {
  const { state, ids } = loop;
  const fail = (code: Extract<TerminalResult, { status: "failed" }>["code"]) =>
    loop.finish({ status: "failed", code });
  if (result.finishReason === "refusal") return fail("refused");
  if (result.finishReason === "length" || result.finishReason === "other")
    return fail("invalid_response");
  if (!result.toolCalls.length) {
    const text =
      result.finishReason === "stop"
        ? result.content.trim()
          ? result.content
          : lastAssistantText(state.messages)
        : undefined;
    if (text) {
      state.messages.push({
        role: "assistant",
        content: text,
        toolCalls: [],
        ...(result.providerMetadata
          ? { providerMetadata: result.providerMetadata }
          : {}),
      });
      if (state.rounds < loop.maxRounds) {
        const steered = state.steered?.length ?? 0;
        const stopped = await drainSteering(loop);
        if (stopped || (state.steered?.length ?? 0) > steered) return stopped;
      }
    }
    return loop.finish(
      text
        ? { status: "completed", text }
        : { status: "failed", code: "invalid_response" },
    );
  }
  if (result.finishReason !== "tool_calls") return fail("invalid_response");
  if (state.calls + result.toolCalls.length > loop.maxToolCalls)
    return fail("limit");
  const seen = new Set<string>();
  const calls: ToolCall[] = [];
  for (const call of result.toolCalls) {
    if (!call.id || seen.has(call.id)) return fail("invalid_response");
    seen.add(call.id);
    const id = ids.has(call.id)
      ? `${call.id}-r${String(state.rounds)}`
      : call.id;
    if (ids.has(id)) return fail("invalid_response");
    ids.add(id);
    loop.fresh.add(id);
    calls.push({ ...call, id });
  }
  state.messages.push({
    role: "assistant",
    content: result.content,
    toolCalls: calls,
    ...(result.providerMetadata
      ? { providerMetadata: result.providerMetadata }
      : {}),
  });
  state.pending = [...calls];
  await loop.save();
  return undefined;
}
function lastAssistantText(messages: readonly Turn[]): string | undefined {
  let used = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const turn = messages[index];
    if (turn?.role === "user") break;
    if (turn?.role === "tool") used = true;
    else if (turn?.role === "assistant" && turn.content.trim() && used)
      return turn.content;
  }
  return undefined;
}
