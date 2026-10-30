# Provider configuration

Select a provider and supply its key. Yada supplies the default model.

```ts
const provider = createProvider({
  provider: "anthropic",
  apiKey: secretFromYourServer,
});
```

Import `createProvider` from Yada's public entry point. Keep this configuration on the server. An optional `model` field overrides the default.

For the live example, copy `.env.example` to `.env`:

```dotenv
YADA_PROVIDER=anthropic
YADA_API_KEY=your-key
```

Run `npm run demo:live`. The optional `YADA_MODEL` overrides the model. `providerConfigFromEnv` converts these variables into the same configuration object; it does not read environment variables itself.

Anthropic is currently the only implemented live provider. Its default is `claude-sonnet-4-6`, a [version-specific model ID](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions). Unsupported providers and blank values fail validation. Configuration errors never include the supplied secret.

New adapters should use this same provider/key configuration contract and supply their own default model. Provider-specific credentials should only be introduced when an authentication mechanism actually requires them.
