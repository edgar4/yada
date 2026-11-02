---
layout: doc
title: "LLM provider configuration"
description: "Configure hosted and local model providers for Yada, including Anthropic, OpenAI, Gemini, DeepSeek, Ollama, llama.cpp and any OpenAI-compatible endpoint. Keep credentials on your server."
---

# LLM provider configuration

Choose your model provider, its model ID, and the API key from your account with that provider. These are provider credentials; Yada does not issue an API key.

For the live example, copy `.env.example` to `.env`:

```dotenv
YADA_LLM_PROVIDER=anthropic
YADA_LLM_MODEL=claude-opus-5-5
YADA_LLM_API_KEY=your-anthropic-api-key
```

| Setting             | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `YADA_LLM_PROVIDER` | The company or service hosting the model.                            |
| `YADA_LLM_MODEL`    | The exact API model ID offered by that provider, not a display name. |
| `YADA_LLM_API_KEY`  | The key issued by the selected provider for your account.            |

Run `npm run demo:live`. Keep credentials on the server and outside version control.

The equivalent server-side configuration is:

```ts
const provider = createProvider({
  provider: "anthropic",
  model: "claude-opus-5-5",
  apiKey: secretFromYourServer,
});
```

Import `createProvider` from Yada's public entry point. `providerConfigFromEnv` converts the environment settings into this same object. You may omit the model to use the adapter's default; the example includes it so the selection is explicit.

When switching providers, replace all three values: provider, its model ID, and its API key. The field names stay the same. Supported providers are `anthropic`, `openai`, `gemini`, `deepseek`, `ollama`, `llamacpp`, and `openai-compatible`. Unsupported providers and blank settings fail validation without including the supplied secret in the error.

## Provider selection

| Provider            | Default model                 | API key                       |
| ------------------- | ----------------------------- | ----------------------------- |
| `anthropic`         | `claude-opus-5-5`             | Your Anthropic API key        |
| `openai`            | `gpt-6-luna`                  | Your OpenAI API key           |
| `gemini`            | `gemini-3.8-flash`            | Your Google AI Studio API key |
| `deepseek`          | `deepseek-flash`              | Your DeepSeek API key         |
| `ollama`            | Select an installed model     | Optional server API key       |
| `llamacpp`          | Select the served model alias | Optional server API key       |
| `openai-compatible` | Required; also set `baseUrl`  | Optional gateway API key      |

Gemini uses the official `@google/genai` SDK, an optional peer dependency: run `npm install @google/genai` before selecting `gemini`. `chatModelAdapter` needs `@langchain/core`. The other providers use their native SDKs, which ship with Yada. Without the package, the first Gemini request fails with an error naming it.

Local and OpenAI-compatible providers do not accept images unless the config sets `vision: true`.

For OpenAI:

```dotenv
YADA_LLM_PROVIDER=openai
YADA_LLM_MODEL=gpt-6-luna
YADA_LLM_API_KEY=your-openai-api-key
```

For Gemini:

```dotenv
YADA_LLM_PROVIDER=gemini
YADA_LLM_MODEL=gemini-3.8-flash
YADA_LLM_API_KEY=your-google-ai-studio-api-key
```

Use the provider's exact API model ID when overriding the default. The selected model must support text and function calling for tool workflows. Provider access and model availability depend on your account. Hosted adapters require API-key authentication. Azure OpenAI and Vertex AI are not configured by this interface.

Anthropic, OpenAI, DeepSeek, Ollama, llama.cpp and OpenAI-compatible servers use native adapters on the official `@anthropic-ai/sdk` and `openai` SDKs (Messages, Responses and Chat Completions; hosted OpenAI in Chat Completions mode sends `max_completion_tokens`, other servers `max_tokens`). Gemini uses a native adapter on `@google/genai` (`generateContent` and `generateContentStream`). Any LangChain chat model can be wrapped with `chatModelAdapter`. The default `gpt-6-luna` supports function calling there only with reasoning disabled, so Yada sends `reasoning_effort: none` when you use the default model; set your own `model` to avoid this. Gemini omits tool call IDs on some models, so Yada generates `gemini_call_N` IDs and leaves them out of the request; thought signatures are kept in provider metadata and replayed with the same turn's function calls. Safety, recitation and prohibited-content finish reasons end the run as `refusal`; usage includes thinking tokens in the output count and cached tokens as `cacheReadTokens`. Provider metadata cannot be reused with another provider. Transient failures are retried by the provider SDK with backoff (`maxRetries`, default 2). Aborted runs are never retried; remaining failures return through the runtime's error contract.

Model references: [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [Google Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

## DeepSeek

```dotenv
YADA_LLM_PROVIDER=deepseek
YADA_LLM_MODEL=deepseek-flash
YADA_LLM_API_KEY=your-deepseek-api-key
```

Yada routes requests to `https://api.deepseek.com` using Chat Completions with thinking disabled. This uses DeepSeek's documented [non-thinking tool-call mode](https://api-docs.deepseek.com/guides/tool_calls/). No extra endpoint setting is needed.

## Tuning and endpoints

All providers accept these optional settings. `baseUrl` must be an `http(s)` URL without credentials, query or fragment, and is trusted server configuration.

| Setting (code / env)                   | Default                           | Meaning                                             |
| -------------------------------------- | --------------------------------- | --------------------------------------------------- |
| `maxTokens` / `YADA_LLM_MAX_TOKENS`    | 8192 hosted, server default local | Maximum output tokens per model call.               |
| `temperature` / `YADA_LLM_TEMPERATURE` | provider default                  | Sampling temperature, 0 to 2.                       |
| `maxRetries` / `YADA_LLM_MAX_RETRIES`  | 2                                 | Retries for transient errors, 0 to 10.              |
| `baseUrl` / `YADA_LLM_BASE_URL`        | provider default                  | Override the API endpoint (proxy, gateway, region). |
| `headers` (code only)                  | none                              | Extra HTTP headers as a record of strings.          |

## Model settings

Every provider accepts the same settings. Yada maps each one to the provider's own parameter and ignores it where the provider has no equivalent, so switching providers never needs a config change.

| Setting (code / env)                    | Values                               | Default                                            | Anthropic              | OpenAI             | Gemini                       | DeepSeek, local, compatible |
| --------------------------------------- | ------------------------------------ | -------------------------------------------------- | ---------------------- | ------------------ | ---------------------------- | --------------------------- |
| `temperature` / `YADA_LLM_TEMPERATURE`  | 0 to 2                               | provider default                                   | ignored                | `temperature`      | `temperature`                | `temperature`               |
| `effort` / `YADA_LLM_EFFORT`            | `low` `medium` `high` `xhigh` `max`  | provider default (`none` for default OpenAI model) | `output_config.effort` | `reasoning.effort` | `thinkingLevel` (max `HIGH`) | ignored                     |
| `thinkingDisplay` (code only)           | `summarized` `omitted`               | provider default                                   | `thinking.display`     | ignored            | ignored                      | ignored                     |
| `promptCache` / `YADA_LLM_PROMPT_CACHE` | `5m` `1h` `off`                      | `5m`                                               | `cache_control` TTL    | automatic          | ignored                      | ignored                     |
| `serverTools` / `YADA_LLM_SERVER_TOOLS` | `web_search` `code_execution` `none` | `web_search`                                       | hosted tools           | hosted tools       | hosted tools                 | ignored                     |

Hosted `openai` uses the Responses API with `store: false`; reasoning items are kept in provider metadata and replayed before their tool calls. Without `model` and `effort` it defaults to `gpt-6-luna` with `effort: "none"`. DeepSeek, local and compatible servers use Chat Completions; DeepSeek runs in [non-thinking tool-call mode](https://api-docs.deepseek.com/guides/tool_calls/).

Anthropic and Gemini thinking blocks are kept in provider metadata and sent back unchanged on later tool rounds. Anthropic caches the system prompt, tools and history by default; use `promptCache: "off"` for gateways that reject `cache_control`. Usage reports `inputTokens` as the total including cached tokens, plus `cacheReadTokens` and `cacheWriteTokens` when the provider returns them.

## Server-side tools

`serverTools` (comma-separated in `YADA_LLM_SERVER_TOOLS`, e.g. `web_search,code_execution`) enables provider-hosted `web_search` and `code_execution` on Anthropic, OpenAI and Gemini. Web search is on by default for these providers; set `none` (code: `serverTools: []`) to turn it off. `code_execution` is opt-in.

```ts
createProvider({
  provider: "anthropic",
  apiKey: secretFromYourServer,
  serverTools: ["web_search", "code_execution"],
  webSearch: { maxUses: 3, allowedDomains: ["docs.example.com"] },
});
```

| Provider    | `web_search`          | `code_execution`          |
| ----------- | --------------------- | ------------------------- |
| `anthropic` | `web_search_20260318` | `code_execution_20260521` |
| `openai`    | `web_search`          | `code_interpreter`        |
| `gemini`    | `googleSearch`        | `codeExecution`           |

`webSearch.maxUses` bounds cost: Anthropic `max_uses`, OpenAI `max_tool_calls` (counts every built-in tool call). `webSearch.allowedDomains` limits results (Anthropic, OpenAI). Gemini ignores `webSearch`.

These tools run on the provider, are never exposed as Yada tools, and bypass policy, approvals and `maxToolCalls`. They appear in tracing as part of the model span. Final `content` stays plain text; cited sources are returned as `providerMetadata.data.sources` (`{ url, title }[]`, deduplicated by URL) and the number of calls as `usage.serverToolCalls`. The raw server-tool blocks stay in provider metadata and are replayed on later rounds to the same provider. Anthropic `pause_turn` is continued automatically up to three times, then the result finishes with `other`.

Provider pricing for server tools is not included in Yada's cost limits.

## OpenAI-compatible endpoints

Use `openai-compatible` for OpenRouter, Groq, Together, vLLM, LM Studio or an Azure-compatible gateway that speaks Chat Completions. `model` and `baseUrl` are required; `apiKey` is optional.

```dotenv
YADA_LLM_PROVIDER=openai-compatible
YADA_LLM_MODEL=vendor/model-id
YADA_LLM_BASE_URL=https://openrouter.ai/api/v1
YADA_LLM_API_KEY=your-gateway-api-key
```

## Local open-source servers

Start your server and load a model that supports tool calling, then configure Yada. Model licenses and capabilities depend on the model you choose.

For [Ollama](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx), first install a tool-capable model such as `llama3.1:8b`:

```dotenv
YADA_LLM_PROVIDER=ollama
YADA_LLM_MODEL=llama3.1:8b
```

For [llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), start `llama-server` with your model, a tool-compatible chat template, `--jinja`, and an alias matching the model setting:

```dotenv
YADA_LLM_PROVIDER=llamacpp
YADA_LLM_MODEL=local-model
```

Defaults are `http://localhost:11434/v1` for Ollama and `http://localhost:8080/v1` for llama.cpp. Yada connects to the server; it does not download models or launch it.

Local providers require a model name but no API key. Remove `YADA_LLM_API_KEY` when switching from a hosted provider to an unauthenticated local server. If your server requires authentication, supply its key using the same setting.

Optionally set `YADA_LLM_BASE_URL` (or `baseUrl` in code) for a local provider running elsewhere. Include the `/v1` base path. Endpoint overrides must be trusted server configuration. In containers, `localhost` refers to the container running Yada.
