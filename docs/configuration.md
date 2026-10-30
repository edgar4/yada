---
layout: doc
title: "LLM provider configuration"
---

# LLM provider configuration

Choose your model provider, its model ID, and the API key from your account with that provider. These are provider credentials; Yada does not issue an API key.

For the live example, copy `.env.example` to `.env`:

```dotenv
YADA_LLM_PROVIDER=anthropic
YADA_LLM_MODEL=claude-sonnet-4-6
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
  model: "claude-sonnet-4-6",
  apiKey: secretFromYourServer,
});
```

Import `createProvider` from Yada's public entry point. `providerConfigFromEnv` converts the environment settings into this same object. You may omit the model to use the adapter's default; the example includes it so the selection is explicit.

When switching providers, replace all three values: provider, its model ID, and its API key. The field names stay the same. Supported providers are `anthropic`, `openai`, `gemini`, `deepseek`, `ollama`, and `llamacpp`. Unsupported providers and blank settings fail validation without including the supplied secret in the error.

## Provider selection

| Provider    | Default model                 | API key                       |
| ----------- | ----------------------------- | ----------------------------- |
| `anthropic` | `claude-sonnet-4-6`           | Your Anthropic API key        |
| `openai`    | `gpt-4.1-mini`                | Your OpenAI API key           |
| `gemini`    | `gemini-3.8-flash`            | Your Google AI Studio API key |
| `deepseek`  | `deepseek-flash`              | Your DeepSeek API key         |
| `ollama`    | Select an installed model     | Optional server API key       |
| `llamacpp`  | Select the served model alias | Optional server API key       |

For OpenAI:

```dotenv
YADA_LLM_PROVIDER=openai
YADA_LLM_MODEL=gpt-4.1-mini
YADA_LLM_API_KEY=your-openai-api-key
```

For Gemini:

```dotenv
YADA_LLM_PROVIDER=gemini
YADA_LLM_MODEL=gemini-3.8-flash
YADA_LLM_API_KEY=your-google-ai-studio-api-key
```

Use the provider's exact API model ID when overriding the default. The selected model must support text and function calling for tool workflows. Provider access and model availability depend on your account. Hosted adapters require API-key authentication. Azure OpenAI and Vertex AI are not configured by this interface.

The OpenAI adapter uses Chat Completions. Gemini tool-call signatures are retained across turns within a run. Provider metadata cannot be reused with another provider. Retries are disabled at the adapter boundary; failures return through the runtime's error contract.

Model references: [OpenAI GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) and [Google Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

## DeepSeek

```dotenv
YADA_LLM_PROVIDER=deepseek
YADA_LLM_MODEL=deepseek-flash
YADA_LLM_API_KEY=your-deepseek-api-key
```

Yada routes requests to `https://api.deepseek.com` using Chat Completions with thinking disabled. This uses DeepSeek's documented [non-thinking tool-call mode](https://api-docs.deepseek.com/guides/tool_calls/). No extra endpoint setting is needed.

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

Optionally set `YADA_LLM_BASE_URL` (or `baseUrl` in code) for a local provider running elsewhere. Include the `/v1` base path. Endpoint overrides are accepted only for `ollama` and `llamacpp`, and must be trusted server configuration. In containers, `localhost` refers to the container running Yada.
