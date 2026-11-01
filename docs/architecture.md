---
layout: doc
title: "Runtime architecture"
description: "Understand Yada’s runtime boundaries, provider and tool contracts, authorization checks, execution limits and durable checkpoint behavior."
---

# Runtime architecture

Yada is a server-side TypeScript runtime. Applications compose a model adapter and read tools through `src/index.ts`.

## Boundaries

- `core` owns normalized messages, tool contracts, authorization, and bounded execution. It cannot import concrete providers or application integrations.
- `providers` translate model SDK messages into the core contract. Model credentials stay on the server.
- Applications supply authenticated actor and tenant identity, tool authorization, and typed handlers. Browser-supplied identity must be verified before invoking Yada.

## Execution

Each run discovers authorized tools, invokes the provider, validates tool arguments, rechecks authorization, and returns tool results to the provider. Round and call limits bound execution.

Read-tool failures are returned to the model as a JSON tool result, `{"error": "<category>", "message": "..."}`, so it can self-correct. Categories: `unknown_tool` (unknown or unauthorized name), `invalid_arguments` (Zod issue paths and messages, never raw values) and `tool_failed` (generic text; dependency errors are not exposed). `maxFailures` (3) consecutive failed tool results fail the run with `dependency_failed`; the count is stored in the checkpoint. Write-tool errors, authorization revoked after a tool was offered or before a recovered call runs (`tool_denied`), and checkpoint errors remain terminal. Cancellation always yields `cancelled`.

Consecutive read-tool calls in one response run concurrently, up to `maxParallelTools`; write calls run alone, in order, and act as barriers. Tool messages are appended and failures counted in call order, and each result is checkpointed as soon as all earlier results exist, so a resumed run re-runs only reads without a stored result. A terminal failure or cancellation aborts the reads still in flight.

Tool output over `maxToolOutput` (32,000) characters is truncated and ends with `…[truncated N chars]`. A call ID the provider reuses from an earlier round is rewritten to `<id>-r<round>`; duplicate IDs within one response fail with `invalid_response`.

Termination: `stop` with text completes. `stop` with empty text after tool use completes with the latest non-empty assistant text of the run, otherwise fails with `invalid_response`. `length` and `other` fail with `invalid_response`. `refusal` (including content-filter and safety stops) fails with `refused`. Limits fail with `limit`.

## Multimodal content

User input and tool results may be a string or an array of parts: `{ type: "text", text }` and `{ type: "image", mimeType, data }` (base64; png, jpeg, webp or gif; at most 5 MB decoded per image and 4 images per turn). Strings stay valid everywhere, including old checkpoints and stored history. Images reach the model only when `provider.capabilities.vision` is true (Anthropic, OpenAI and Gemini; `vision: true` on `ollama`, `llamacpp` or `openai-compatible` configs; custom adapters set it themselves). Without vision, input containing images fails with `unsupported`, and tool-result images are replaced by `[image: mime]` text. Tool-result images are sent to the model in a user message that follows the tool messages, because several providers only accept text in tool messages. Truncation applies to each text part; images count toward the context size by their base64 length, and compaction replaces a tool result containing images with `[compacted: N chars]`. Events (`tool_finished`), tracing and the HTTP history never carry image data, only `[image: mime]` text. Confirm-mode (`ask`) tools return text only.

## Limits and hooks

`limits` holds every runtime number with its default: `maxContextChars` 256,000, `maxRounds` 8, `maxToolCalls` 16, `maxFailures` 3, `maxParallelTools` 4, `maxToolOutput` 32,000. The `maxRounds` and `maxToolCalls` run options override the limits. When the context exceeds `maxContextChars`, the runtime first replaces the content of the oldest tool results, excluding the latest round, with `[compacted: N chars]` (checkpointed, earlier turns otherwise unchanged); it fails with `limit` only if still over. Compaction edits earlier turns, so providers that bind reasoning blocks to an unchanged history (Anthropic Claude 5 preserved thinking) may drop or reject those blocks after a compaction; size the limits so compaction stays rare for those models.

`run` accepts `hooks?: RunHooks`, honoured on checkpoint resume. Members are optional and may be async.

- `beforeModel(request)` may return an edited `{ system, messages, tools }` for that call only; the checkpoint is unchanged.
- `afterModel(result)` observes the provider result.
- `beforeTool(call, tool)` may return `{ deny: reason }`; the call becomes a `denied` error tool result and counts as a failure.
- `afterTool(call, content)` may return replacement content (redaction) before truncation. For results with parts it runs once per text part with that text; images pass through unchanged.
- `onEvent(event)` receives `AgentEvent`: `round_started`, `tool_started`, `tool_finished`, `text_delta` (`delta`), `model_finished` (with usage), `run_finished` and `run_suspended` (the run returned `awaiting_approval` or `reconciling`). It is fire-and-forget and its errors are ignored. Errors from other hooks fail the run with `dependency_failed`.

`ProviderAdapter` may implement `stream(request)`, an async generator that yields `{ type: "text", delta }` and returns the same `ProviderResult` that `complete` would. When the provider has `stream` and an `onEvent` hook is set, the runtime calls `stream` instead of `complete` and emits a `text_delta` event per delta; classification, usage and checkpoints use the returned result, so streaming never changes the outcome. The native Anthropic adapter streams with the SDK stream helper and converts its final message; the native OpenAI-compatible adapter aggregates chat completion chunks (`stream_options.include_usage`). Both use the same conversion as `complete`, including usage and finish reason. The LangChain adapter (Gemini and `chatModelAdapter`) implements `stream` with `.stream()` and aggregates chunks the same way, including `providerMetadata` (Gemini signatures). Provider metadata drops descriptive fields (`id`, `usage`, `finishReason`, `index` and similar) so both paths store identical data. `createFakeProvider(script, deltas)` streams scripted deltas.

Cancellation returns promptly even when a dependency ignores its signal. It cannot stop underlying work in that dependency; handlers must honor `AbortSignal`. Callers supply a deadline signal.

## Current capabilities

The runtime supports read tools, a scripted testing provider, and native adapters for Anthropic (`src/providers/native/anthropic.ts`, Messages API, the full ordered assistant content kept in `providerMetadata.data.contentBlocks` and replayed verbatim; legacy `thinkingBlocks` still replay) and OpenAI-compatible servers (OpenAI, DeepSeek, Ollama, llama.cpp, `src/providers/native/openai.ts`, Chat Completions) built on the official SDKs with their built-in retries, plus Gemini through LangChain; `chatModelAdapter` wraps any LangChain chat model. Tool input schemas use Zod and infer handler argument types. Provider tests cover SDK mappings and real SDK execution for hosted and local providers with mocked HTTP responses.

`run` defaults to in-memory execution and accepts typed checkpoint hooks. `runDurable` adds encrypted checkpoints and renewable execution leases through the storage boundary. See [run recovery](recovery.md). `runConversation` adds durable full-turn conversation history (tool calls, results, provider metadata, failure markers) through the storage interface. OAuth sessions can use the same encrypted storage. See [durable storage](storage.md).

## Sub-agents

`agentTool({ name, description, provider, tools, system, limits?, maxRounds?, hooks?, authorize? })` returns a read tool with input `{ task }` that runs a nested `run()` with the caller's identity and signal and returns the completed text. `authorize` gates which identities see the sub-agent (default: everyone); its inner tools still apply their own authorization. A failed or suspended sub-agent returns `{"error": "agent_failed", "message": "The sub-agent failed: <code>"}` as the tool result, so the parent model sees only the failure code. Cancellation propagates through the shared signal. Write tools are rejected at construction, and agent tools nest at most two deep (checked at construction). The parent's hooks and limits do not apply inside the sub-agent; pass `hooks` and `limits` to `agentTool`, and note each call gets its own budget. Sub-agent runs are in-memory with no checkpoint, so a resumed parent re-runs the sub-agent, which is safe because it is read-only.

## Development checks

Use Node 24 (`nvm use`), install with `npm ci`, and run `npm run check`. This checks formatting, typed lint rules, strict TypeScript, tests with coverage thresholds, and compilation. `npm run demo` exercises a tool round trip without credentials.
