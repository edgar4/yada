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

When switching providers, replace all three values: provider, its model ID, and its API key. The field names stay the same. Anthropic is currently the only implemented live adapter; OpenAI and Gemini adapters are not available yet. Unsupported providers and blank settings fail validation without including the supplied secret in the error.

The Anthropic default is `claude-sonnet-4-6`. Use the provider's exact model ID for other models or versions.
