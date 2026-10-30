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

When switching providers, replace all three values: provider, its model ID, and its API key. The field names stay the same. Supported providers are `anthropic`, `openai`, and `gemini`. Unsupported providers and blank settings fail validation without including the supplied secret in the error.

## Provider selection

| Provider    | Default model       | API key                       |
| ----------- | ------------------- | ----------------------------- |
| `anthropic` | `claude-sonnet-4-6` | Your Anthropic API key        |
| `openai`    | `gpt-4.1-mini`      | Your OpenAI API key           |
| `gemini`    | `gemini-3.8-flash`  | Your Google AI Studio API key |

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

Use the provider's exact API model ID when overriding the default. The selected model must support text and function calling for tool workflows. Provider access and model availability depend on your account. These adapters use API-key authentication; Azure OpenAI, Vertex AI, and custom endpoints are not configured by this interface.

The OpenAI adapter uses Chat Completions. Gemini tool-call signatures are retained across turns within a run. Provider metadata cannot be reused with another provider. Retries are disabled at the adapter boundary; failures return through the runtime's error contract.

Model references: [OpenAI GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) and [Google Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
