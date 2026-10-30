# Yada

Standalone TypeScript assistant runtime, under development.

See [provider configuration](docs/configuration.md) and [runtime architecture](docs/architecture.md) for contracts and execution boundaries.

```sh
nvm use
npm ci
npm run check
npm run demo
```

The first slice supports typed read tools, a deterministic provider, and an Anthropic adapter. It is not yet a production assistant: MCP, SQLite persistence, approvals, and website embedding are planned. Tool handlers are trusted server code and must honor cancellation. The host supplies authenticated identity and authorization; never accept identity directly from a browser request.

Core owns contracts and execution. Providers depend on core contracts. Applications compose dependencies through the public exports in `src/index.ts`. Runtime schemas validate model-supplied arguments before invoking typed handlers.

For an opt-in live model run, copy `.env.example` to `.env`, select your LLM provider and model, and enter the API key issued by that provider, then run `npm run demo:live`. This sends a request to the provider and may incur usage charges. Automated tests use mocked responses and require no credentials.

Planned storage is user-configurable: SQLite by default, with PostgreSQL and MySQL/MariaDB adapters. Persistence is not implemented yet.
