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

Tool output over `maxToolOutput` (32,000) characters is truncated and ends with `…[truncated N chars]`. A call ID the provider reuses from an earlier round is rewritten to `<id>-r<round>`; duplicate IDs within one response fail with `invalid_response`.

Termination: `stop` with text completes. `stop` with empty text after tool use completes with the latest non-empty assistant text of the run, otherwise fails with `invalid_response`. `length` and `other` fail with `invalid_response`. `refusal` (including content-filter and safety stops) fails with `refused`. Limits fail with `limit`.

## Limits and hooks

`limits` holds every runtime number with its default: `maxContextChars` 64,000, `maxRounds` 8, `maxToolCalls` 16, `maxFailures` 3, `maxToolOutput` 32,000. The `maxRounds` and `maxToolCalls` run options override the limits.

`run` accepts `hooks?: RunHooks`, honoured on checkpoint resume. Members are optional and may be async.

- `beforeModel(request)` may return an edited `{ system, messages, tools }` for that call only; the checkpoint is unchanged.
- `afterModel(result)` observes the provider result.
- `beforeTool(call, tool)` may return `{ deny: reason }`; the call becomes a `denied` error tool result and counts as a failure.
- `afterTool(call, content)` may return replacement content (redaction) before truncation.
- `onEvent(event)` receives `AgentEvent`: `round_started`, `tool_started`, `tool_finished`, `model_finished` (with usage) and `run_finished`. It is fire-and-forget and its errors are ignored. Errors from other hooks fail the run with `dependency_failed`.

Cancellation returns promptly even when a dependency ignores its signal. It cannot stop underlying work in that dependency; handlers must honor `AbortSignal`. Callers supply a deadline signal.

## Current capabilities

The runtime supports read tools, a scripted testing provider, and Anthropic, OpenAI, Gemini, DeepSeek, Ollama, and llama.cpp through LangChain. Tool input schemas use Zod and infer handler argument types. Provider tests cover SDK mappings and real SDK execution for hosted and local providers with mocked HTTP responses.

`run` defaults to in-memory execution and accepts typed checkpoint hooks. `runDurable` adds encrypted checkpoints and renewable execution leases through the storage boundary. See [run recovery](recovery.md). `runConversation` adds durable completed conversation history through the storage interface. OAuth sessions can use the same encrypted storage. See [durable storage](storage.md).

## Development checks

Use Node 24 (`nvm use`), install with `npm ci`, and run `npm run check`. This checks formatting, typed lint rules, strict TypeScript, tests with coverage thresholds, and compilation. `npm run demo` exercises a tool round trip without credentials.
