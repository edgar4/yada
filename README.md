# Yada

A standalone AI agent built in TypeScript, with typed tools and configurable model providers. Yada chooses tools, executes steps, and uses the results to continue helping the user.

Embed the agent runtime in your backend and add an assistant interface to your website. Yada supports approved actions, durable conversations, and recovery after restarts.

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

Use [durable storage](docs/storage.md) to retain conversations and OAuth sessions across restarts, and [durable runs](docs/recovery.md) to resume interrupted execution. SQLite is the default; PostgreSQL and MySQL are also supported.

Connect [HTTP APIs and business databases](docs/connectors.md), or build [approved write tools](docs/actions.md) with durable operation receipts. Use the [service API](docs/service.md) for scheduled runs and streaming events, and the [browser SDK and widget](docs/browser.md) for an accessible, themeable chat interface.

See [operations](docs/operations.md) for context and usage controls, backup/restore, key rotation, and retention. Existing applications can use the [provider compatibility bridge](docs/integrations.md) during a local migration rehearsal.

See [packaging and deployment](docs/deployment.md) for installable tarballs, release artifacts and a local Docker example.

## Development

```sh
npx playwright install chromium
npm run check
npm run test:package
```

Runs formatting checks, linting, type checking, tests, and compilation. Automated tests require no provider credentials.
