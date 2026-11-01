# Yada

A plug-and-play AI agent harness for TypeScript backends. Bring any model, any MCP server and Agent Skills from Claude, Codex or Cursor; Yada runs the tool loop, asks before it acts, and picks up where it left off after a restart.

- **Any model:** Anthropic and OpenAI on their official SDKs, Gemini, DeepSeek, Ollama, llama.cpp or any OpenAI-compatible endpoint.
- **Any tools:** typed tools, MCP servers (stdio or HTTP, OAuth), HTTP APIs, business databases and reusable `SKILL.md` skills.
- **Safe actions:** writes need explicit approval, run at most once and keep durable receipts.
- **Durable by default:** conversations, runs and approvals survive restarts on SQLite, PostgreSQL or MySQL.
- **Ready for users:** streaming service API, browser client and an accessible chat widget.

## Used by

[Talon](https://talonhr.eu) uses Yada. Talon is hiring software that gives employers and recruitment agencies one shared workspace for roles, candidates, interviews and offers. Using Yada in production? Open a pull request to add your project here.

## Create an agent

With Node 24, generate a complete app with storage, skills, typed tools and the chat widget:

```sh
npx @edgaralochi/yada init my-agent
cd my-agent
```

Set your provider credentials in `.env.starter`, then run `npm start`. See the [starter guide](docs/starter.md).

## Install

Requires Node 24:

```sh
npm install @edgaralochi/yada
```

Import the runtime from `@edgaralochi/yada`, the browser client from `@edgaralochi/yada/client` and the widget from `@edgaralochi/yada/widget`. Narrower entry points are `/providers`, `/storage`, `/mcp`, `/skills` and `/service`; the root exports all of them.

The core and the Anthropic and OpenAI-compatible providers need nothing else. Install only what you use:

| Feature                    | Install                                               |
| -------------------------- | ----------------------------------------------------- |
| SQLite storage (default)   | `npm install better-sqlite3`                          |
| PostgreSQL storage         | `npm install pg`                                      |
| MySQL storage              | `npm install mysql2`                                  |
| Gemini, `chatModelAdapter` | `npm install @langchain/core @langchain/google-genai` |

Using a feature without its package fails with an error naming what to install.

## Connect your model provider

Copy `.env.example` to `.env` and enter your provider credentials:

```dotenv
YADA_LLM_PROVIDER=anthropic
YADA_LLM_MODEL=claude-opus-5-5
YADA_LLM_API_KEY=your-anthropic-api-key
```

Run the catalog example with a live model:

```sh
npm run demo:live
```

The key belongs to your selected provider; live requests may incur usage charges. Keep `.env` private. See [provider configuration](docs/configuration.md).

## Documentation

| Topic                                         | Guide                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Runtime, limits and termination               | [Architecture](docs/architecture.md)                                  |
| External tool servers                         | [MCP](docs/mcp.md), [MCP OAuth](docs/mcp-oauth.md)                    |
| Reusable skills                               | [Skills](docs/skills.md)                                              |
| HTTP APIs and databases                       | [Connectors](docs/connectors.md)                                      |
| Approved write tools                          | [Actions](docs/actions.md)                                            |
| Conversations and recovery                    | [Storage](docs/storage.md), [Durable runs](docs/recovery.md)          |
| Service API, streaming and chat UI            | [Service](docs/service.md), [Browser SDK and widget](docs/browser.md) |
| Context, cost, backups and retention          | [Operations](docs/operations.md)                                      |
| Packaging and Docker                          | [Deployment](docs/deployment.md)                                      |
| Agent scenarios in CI and against live models | [Evals](docs/evals.md)                                                |

## Develop from source

```sh
nvm use
npm ci
npm run demo
```

The demo runs a catalog lookup without an API key. For the full starter, run `npm run starter:init`, add credentials to `.env.starter`, then `npm run starter`.

Before opening a pull request:

```sh
npx playwright install chromium
npm run check
npm run test:package
```

Automated tests require no provider credentials.

## Upgrading from 0.2

- `better-sqlite3`, `pg`, `mysql2` and the LangChain packages are optional peer dependencies; install the ones you use.
- `@langchain/anthropic` and `@langchain/openai` are no longer used; Anthropic and OpenAI-compatible providers run on the official SDKs.
- `ReadTool.execute` returns `Content` (a string or an array of text and image parts) instead of `string`.
- `temperature` is rejected for `anthropic`; use `effort` instead.
- `maxContextChars` defaults to 256,000 and service `historyChars` to 128,000.

## License

[MIT](LICENSE)
