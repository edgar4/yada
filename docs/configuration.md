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

The OpenAI adapter uses Chat Completions. The default `gpt-6-luna` supports function calling there only with reasoning disabled, so Yada sends `reasoning_effort: none` when you use the default model; set your own `model` to avoid this. Gemini tool-call signatures are retained across turns within a run. Provider metadata cannot be reused with another provider. Transient failures are retried by the provider SDK with backoff (`maxRetries`, default 2). Aborted runs are never retried; remaining failures return through the runtime's error contract.

Model references: [OpenAI GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-6-luna) and [Google Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

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

## Anthropic effort and thinking

Claude 5 models think adaptively by default. Control depth with `effort` (`YADA_LLM_EFFORT`), sent as `output_config.effort`, and optionally choose how thinking is returned with `thinkingDisplay`, sent as `thinking: { type: "adaptive", display }`.

```ts
createProvider({
  provider: "anthropic",
  apiKey: secretFromYourServer,
  effort: "high", // low | medium | high | xhigh | max
  thinkingDisplay: "summarized", // or "omitted"
});
```

Thinking and redacted thinking blocks are kept in provider metadata and sent back unchanged on later tool rounds, as Anthropic requires. `effort` and `thinkingDisplay` are accepted only for `anthropic`. `temperature` is rejected for `anthropic` because the Messages API no longer accepts it.

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
