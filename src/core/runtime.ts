import { z } from "zod";
import {
  compactOldest,
  limitsSchema,
  usageCostMicros,
  type RunLimits,
} from "./limits.js";
import { Suspended, type ActionExecutor } from "./action.js";
import type { AgentEvent, ModelCall, RunHooks } from "./hooks.js";
import { abortable } from "./abort.js";
import { contentText, hasImages, mapText, messagesSize } from "./content.js";
import { InvalidArguments } from "./tool.js";
import { transient } from "./transient.js";
import {
  checkpointSchema,
  CheckpointError,
  feedbackPrefix,
  type RunCheckpoint,
  summaryPrefix,
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
const summarySystem =
  "Summarize this conversation for an assistant that will continue it. Keep the facts, decisions, tool results and open questions it still needs. Reply with the summary only.";
export type SummarizeOptions = Readonly<{
  provider?: ProviderAdapter;
  keepTurns?: number;
}>;
const startsWith = (turn: Turn, prefix: string) =>
  turn.role === "user" &&
  typeof turn.content === "string" &&
  turn.content.startsWith(prefix);
const isSummary = (turn: Turn) => startsWith(turn, summaryPrefix);
const isSynthetic = (turn: Turn) =>
  isSummary(turn) || startsWith(turn, feedbackPrefix);
const userIndexes = (messages: readonly Turn[]) =>
  messages.flatMap((turn, index) =>
    turn.role === "user" && !isSynthetic(turn) ? [index] : [],
  );
export const runTurns = (messages: readonly Turn[], steered = 0) =>
  messages.slice(userIndexes(messages).at(-(steered + 1)) ?? 0);
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
  output?: z.ZodType;
  nest?: (call: ToolCall, child: RunOptions) => Promise<ChildRun>;
};
type Loop = {
  options: RunOptions;
  system: string;
  cause?: string | undefined;
  costShare?: number;
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
  | { content: Content; failed: boolean; cause?: string }
  | { stop: RunResult }
  | { terminal: TerminalResult };
const causeText = (error: unknown) =>
  error instanceof Error
    ? `${error.name}: ${error.message}`
        .replace(/\b[\w+/=.~-]{32,}\b/g, "[redacted]")
        .slice(0, 500)
    : undefined;
const hookDrainMs = 5000;
export async function run(options: RunOptions): Promise<RunResult> {
  let queue: Promise<void> = Promise.resolve();
  const emit = (event: AgentEvent) => {
    queue = queue
      .then(() => options.hooks?.onEvent?.(event))
      .catch(() => undefined);
  };
  try {
    const result = await runLoop(options, emit);
    if (
      result.status === "awaiting_approval" ||
      result.status === "reconciling"
    )
      emit({ type: "run_suspended", result });
    return result;
  } finally {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      queue,
      new Promise((resolve) => {
        timer = setTimeout(resolve, hookDrainMs);
      }),
    ]);
    clearTimeout(timer);
  }
}
async function runLoop(
  options: RunOptions,
  emit: (event: AgentEvent) => void,
): Promise<RunResult> {
  const { provider } = options;
  const limits = limitsSchema.parse(options.limits ?? {});
  const deadline = limits.maxDurationMs
    ? AbortSignal.timeout(limits.maxDurationMs)
    : undefined;
  const signal = deadline
    ? AbortSignal.any([options.signal, deadline])
    : options.signal;
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
    emit({
      type: "run_finished",
      result,
      ...(loop.cause &&
      result.status === "failed" &&
      result.code === "dependency_failed"
        ? { cause: loop.cause }
        : {}),
    });
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
    system: options.output
      ? `${options.system}\n\nAnswer with only JSON matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(options.output))}`
      : options.system,
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
      if (
        !provider.capabilities.vision &&
        state.messages.some((turn) => hasImages(turn.content))
      )
        return await finish({ status: "failed", code: "unsupported" });
      const stopped = await executePending(loop);
      if (stopped) return stopped;
      if ((state.failures ?? 0) >= limits.maxFailures)
        return await finish({ status: "failed", code: "dependency_failed" });
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
    if (!options.signal.aborted && !deadline?.aborted)
      loop.cause = causeText(error);
    return finish(
      options.signal.aborted
        ? { status: "cancelled" }
        : deadline?.aborted
          ? { status: "failed", code: "timeout" }
          : { status: "failed", code: "dependency_failed" },
    );
  }
}
async function freshSteering(loop: Loop) {
  const { state, options } = loop;
  if (!options.drainSteering) return [];
  try {
    return (await options.drainSteering()).filter(
      (item) => !state.steered?.includes(item.id),
    );
  } catch {
    throw new CheckpointError();
  }
}
async function drainSteering(loop: Loop): Promise<RunResult | undefined> {
  const { state, options } = loop;
  const fresh = await freshSteering(loop);
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
  if (state.roundFailures !== undefined) {
    const last = state.messages
      .map((turn) => turn.role)
      .lastIndexOf("assistant");
    const turn = state.messages[last];
    const calls = turn?.role === "assistant" ? turn.toolCalls.length : 0;
    state.failures =
      state.roundFailures >= calls ? (state.failures ?? 0) + 1 : 0;
    delete state.roundFailures;
  }
  return undefined;
}
async function executeGroup(
  loop: Loop,
  group: readonly ToolCall[],
  concurrency: number,
): Promise<RunResult | undefined> {
  const { state } = loop;
  const abort = new AbortController();
  const forward = () => {
    abort.abort(loop.signal.reason);
  };
  loop.signal.addEventListener("abort", forward);
  const inner =
    group.length > 1
      ? {
          ...loop,
          signal: abort.signal,
          costShare: Math.min(concurrency, group.length),
        }
      : loop;
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
        slot.resolve({ ...outcome, content });
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
      const { content, failed, cause } = outcome;
      state.messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content,
      });
      state.calls++;
      state.roundFailures = (state.roundFailures ?? 0) + (failed ? 1 : 0);
      if (cause) loop.cause = cause;
      state.pending.shift();
      await loop.save();
      loop.emit({
        type: "tool_finished",
        call,
        content: contentText(content),
        failed,
        ...(cause ? { cause } : {}),
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
  const timeoutMs = tool.timeoutMs ?? loop.limits.toolTimeoutMs;
  const toolSignal =
    timeoutMs === Infinity
      ? signal
      : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    return {
      failed: false,
      content: await abortable(
        () =>
          tool.execute(call.args, identity, toolSignal, {
            addUsage: (usage) => {
              addUsage(loop.state, usage);
            },
            maxOutput: loop.limits.maxToolOutput,
            limits: loop.limits,
            remainingCostMicros: remainingCost(loop),
            ...(nest ? { runChild: (child) => nest(call, child) } : {}),
            ...(options.executeWrite?.ask
              ? { ask: options.executeWrite.ask(call) }
              : {}),
          }),
        toolSignal,
      ),
    };
  } catch (error) {
    if (error instanceof Suspended) return { stop: error.suspension };
    if (error instanceof CheckpointError) throw error;
    signal.throwIfAborted();
    if (toolSignal.aborted)
      return {
        failed: true,
        content: toolError("timeout", "The tool timed out"),
        cause: "TimeoutError: The tool timed out",
      };
    const cause = causeText(error);
    return {
      failed: true,
      ...(cause ? { cause } : {}),
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
    loop.system.length +
    messagesSize(state.messages) +
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
  return reserveCost(loop);
}
function remainingCost({ state, limits, costShare }: Loop) {
  if (limits.maxCostMicros === undefined) return undefined;
  const spent =
    limits.pricing && state.usage
      ? usageCostMicros(limits.pricing, state.usage)
      : 0;
  return Math.max(
    0,
    Math.floor(
      (limits.maxCostMicros - spent - (state.reservedCostMicros ?? 0)) /
        (costShare ?? 1),
    ),
  );
}
function reserveCost(loop: Loop): Promise<RunResult> | undefined {
  const { state, limits } = loop;
  const exceeded = () => loop.finish({ status: "failed", code: "limit" });
  if (limits.maxCostMicros !== undefined && limits.pricing && state.usage) {
    const spent = usageCostMicros(limits.pricing, state.usage);
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
  const { state, options, limits } = loop;
  const users = userIndexes(state.messages);
  const split = Math.min(
    users.at(-(options.summarize?.keepTurns ?? 2)) ?? 0,
    users.at(-((state.steered?.length ?? 0) + 1)) ?? 0,
  );
  const first = state.messages[0];
  const summarized = first !== undefined && isSummary(first);
  let from = 0;
  let to = split;
  if (split < (summarized ? 2 : 1)) {
    from = (users.at(-1) ?? -1) + 1;
    to = state.messages.map((turn) => turn.role).lastIndexOf("assistant");
    if (to <= from) return undefined;
  }
  const stopped = reserveCost(loop);
  if (stopped) return stopped;
  if (loop.limits.costPerCallMicros !== undefined) await loop.save();
  const result = await modelCall(
    loop,
    {
      system: summarySystem,
      messages: [
        {
          role: "user",
          content: state.messages
            .slice(from, to)
            .map((turn) => transcriptLine(turn).slice(0, limits.maxToolOutput))
            .join("\n\n")
            .slice(-Math.floor(limits.maxContextChars * 0.75)),
        },
      ],
      tools: [],
      signal: loop.signal,
    },
    options.summarize?.provider ?? options.provider,
    { purpose: "summary" },
  );
  if (result.finishReason === "refusal")
    return loop.finish({ status: "failed", code: "refused" });
  if (result.finishReason !== "stop" || !result.content.trim())
    return loop.finish({ status: "failed", code: "invalid_response" });
  state.messages.splice(from, to - from, {
    role: "user",
    content: summaryPrefix + result.content,
  });
  await loop.save();
  return undefined;
}
const maxModelRetries = 2;
const retryBaseMs = 500;
async function completeWithRetry(
  provider: ProviderAdapter,
  request: ProviderRequest,
  signal: AbortSignal,
): Promise<ProviderResult> {
  for (let attempt = 0; ; attempt++)
    try {
      return await provider.complete(request);
    } catch (error) {
      await backoff(provider, error, attempt, signal);
    }
}
async function backoff(
  provider: ProviderAdapter,
  error: unknown,
  attempt: number,
  signal: AbortSignal,
) {
  if (
    provider.capabilities.retries ||
    signal.aborted ||
    attempt >= maxModelRetries ||
    !transient(error)
  )
    throw error;
  const delay = retryBaseMs * 2 ** attempt * (0.5 + Math.random() / 2);
  await abortable(
    () => new Promise((resolve) => setTimeout(resolve, delay)),
    signal,
  );
}
async function* streamWithRetry(
  provider: ProviderAdapter,
  request: ProviderRequest,
  signal: AbortSignal,
): AsyncGenerator<{ delta: string }, ProviderResult> {
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      const chunks = provider.stream?.(request);
      if (!chunks) return await provider.complete(request);
      for (;;) {
        const next = await chunks.next();
        if (next.done) return next.value;
        started = true;
        yield next.value;
      }
    } catch (error) {
      if (started) throw error;
      await backoff(provider, error, attempt, signal);
    }
  }
}
async function modelCall(
  loop: Loop,
  request: ProviderRequest,
  provider: ProviderAdapter,
  call: ModelCall = {},
): Promise<ProviderResult> {
  const { state, signal, options } = loop;
  const { hooks } = options;
  const edited = await hooks?.beforeModel?.(request, call);
  if (edited) request = { ...edited, signal };
  let result: ProviderResult;
  if (!call.purpose && provider.stream && hooks?.onEvent) {
    const chunks = streamWithRetry(provider, request, signal);
    for (;;) {
      const next = await abortable(() => chunks.next(), signal);
      if (next.done) {
        result = next.value;
        break;
      }
      loop.emit({ type: "text_delta", delta: next.value.delta });
    }
  } else
    result = await abortable(
      () => completeWithRetry(provider, request, signal),
      signal,
    );
  signal.throwIfAborted();
  addUsage(state, result.usage);
  if (!call.purpose) await loop.save();
  await hooks?.afterModel?.(result, call);
  loop.emit({
    type: "model_finished",
    ...call,
    ...(result.usage ? { usage: result.usage } : {}),
    finishReason: result.finishReason,
  });
  return result;
}
async function callModel(loop: Loop): Promise<ProviderResult> {
  const { state, options } = loop;
  state.rounds++;
  await loop.save();
  loop.emit({ type: "round_started", round: state.rounds });
  return modelCall(
    loop,
    {
      system: loop.system,
      messages: structuredClone(state.messages),
      tools: loop.visible.map((tool) => tool.spec),
      signal: loop.signal,
    },
    options.provider,
  );
}
const maxOutputRetries = 2;
function parseOutput(schema: z.ZodType, text: string) {
  let json: unknown;
  try {
    json = JSON.parse(
      text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
    ) as unknown;
  } catch {
    return "The answer is not valid JSON.";
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { data: parsed.data }
    : parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
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
    let data: unknown;
    if (text) {
      state.messages.push({
        role: "assistant",
        content: text,
        toolCalls: [],
        ...(result.providerMetadata
          ? { providerMetadata: result.providerMetadata }
          : {}),
      });
      if (loop.options.output) {
        const parsed = parseOutput(loop.options.output, text);
        if (typeof parsed === "string") {
          if (
            (state.outputRetries ?? 0) >= maxOutputRetries ||
            state.rounds >= loop.maxRounds
          )
            return fail("invalid_response");
          state.outputRetries = (state.outputRetries ?? 0) + 1;
          state.messages.push({
            role: "user",
            content: `${feedbackPrefix}${parsed}\nAnswer again with only valid JSON.`,
          });
          await loop.save();
          return undefined;
        }
        data = parsed.data;
      }
      if (state.rounds < loop.maxRounds) {
        const steered = state.steered?.length ?? 0;
        const stopped = await drainSteering(loop);
        if (stopped || (state.steered?.length ?? 0) > steered) return stopped;
      } else {
        const count = (await freshSteering(loop)).length;
        if (count) loop.emit({ type: "steering_unconsumed", count });
      }
    }
    return loop.finish(
      text
        ? { status: "completed", text, ...(data === undefined ? {} : { data }) }
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
