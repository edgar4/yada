# Yada

A standalone AI agent built in TypeScript, with typed tools and configurable model providers. Yada chooses tools, executes steps, and uses the results to continue helping the user.

Embed the agent runtime in your application to power an assistant interface.

## Quick start

Use Node 24:

```sh
nvm use
npm ci
npm run demo
```

The demo runs a catalog lookup without an API key.

## Connect your model provider

Copy `.env.example` to `.env` and enter your provider credentials:

```dotenv
YADA_LLM_PROVIDER=anthropic
YADA_LLM_MODEL=claude-sonnet-4-6
YADA_LLM_API_KEY=your-anthropic-api-key
```

Run the same catalog example with a live model:

```sh
npm run demo:live
```

The key belongs to your selected provider. Live requests use your provider account and may incur usage charges. Keep `.env` private.

See [provider configuration](docs/configuration.md) for supported providers, model selection, and server-side configuration. See [MCP connections](docs/mcp.md) to connect external tool servers and [runtime architecture](docs/architecture.md) for execution behavior.

Use [durable storage](docs/storage.md) to retain conversations and OAuth sessions across restarts. SQLite is the default; PostgreSQL and MySQL are also supported.

## Development

```sh
npm run check
```

Runs formatting checks, linting, type checking, tests, and compilation. Automated tests require no provider credentials.
