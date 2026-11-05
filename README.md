# Yada

A plug-and-play AI agent harness for TypeScript backends. Bring any model, any MCP server and Agent Skills from Claude, Codex or Cursor; Yada runs the tool loop, asks before it acts, and picks up where it left off after a restart.

- **Any model:** Anthropic and OpenAI on their official SDKs, Gemini, DeepSeek, Ollama, llama.cpp or any OpenAI-compatible endpoint.
- **Any tools:** typed tools, MCP servers (stdio or HTTP, OAuth), HTTP APIs, business databases and reusable `SKILL.md` skills.
- **Safe actions:** writes need explicit approval, run at most once and keep durable receipts.
- **Durable by default:** conversations, runs and approvals survive restarts on SQLite, PostgreSQL or MySQL.
- **Ready for users:** streaming service API, browser client and an accessible chat widget.

## Used by

[Talon](https://talonhr.eu) uses Yada. Talon is hiring software that gives employers and recruitment agencies one shared workspace for roles, candidates, interviews and offers. Using Yada in production? Open a pull request to add your project here.

## Get started

Two ways in, both on Node 24 or newer.

### Start a new agent app

Generate a complete app with storage, skills, typed tools and the chat widget:

```sh
npx @edgaralochi/yada init my-agent
cd my-agent
```

Set your provider credentials in `.env`, then run `npm start`. See the [starter guide](docs/starter.md).

### Add Yada to an existing backend

```sh
npm install @edgaralochi/yada
```

Import the runtime from `@edgaralochi/yada`, the browser client from `@edgaralochi/yada/client` and the widget from `@edgaralochi/yada/widget` (or the prebuilt `@edgaralochi/yada/widget.js` script). Narrower entry points are `/providers`, `/storage`, `/mcp`, `/skills`, `/service`, `/langchain`, `/otel` and `/evals`; the root exports all of them.

The core and the Anthropic and OpenAI-compatible providers need nothing else. Install only what you use:

| Feature                                            | Install                          |
| -------------------------------------------------- | -------------------------------- |
| SQLite storage (default)                           | `npm install better-sqlite3`     |
| PostgreSQL storage                                 | `npm install pg`                 |
| MySQL storage                                      | `npm install mysql2`             |
| Gemini                                             | `npm install @google/genai`      |
| `chatModelAdapter` (`@edgaralochi/yada/langchain`) | `npm install @langchain/core`    |
| `otelTracer` (`@edgaralochi/yada/otel`)            | `npm install @opentelemetry/api` |

### Use Yada in your backend

```ts
import { z } from "zod";
import {
  createProvider,
  providerConfigFromEnv,
  readTool,
  run,
} from "@edgaralochi/yada";

const provider = createProvider(providerConfigFromEnv(process.env));
const orderStatus = readTool({
  name: "order_status",
  description: "Look up an order by ID.",
  input: z.strictObject({ id: z.string() }),
  authorize: () => Promise.resolve(true),
  execute: ({ id }) => Promise.resolve(`Order ${id}: shipped`),
});

const result = await run({
  provider,
  tools: [orderStatus],
  identity: { actorId: "user-1", tenantId: "acme" },
  input: "Where is order 1042?",
  system: "Help customers with their orders.",
  signal: AbortSignal.timeout(30_000),
});
if (result.status === "completed") console.log(result.text);
```

Set `YADA_LLM_PROVIDER`, `YADA_LLM_API_KEY` and optionally `YADA_LLM_MODEL`. For durable runs, approvals and an HTTP API, see the [worker and handler example](docs/service.md).

Using a feature without its package fails with an error naming what to install. See [provider configuration](docs/configuration.md) to choose a model.

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
| Your own name and look for the chat           | [Widget theming](docs/theming.md)                                     |
| Context, cost, backups and retention          | [Operations](docs/operations.md)                                      |
| Packaging and Docker                          | [Deployment](docs/deployment.md)                                      |
| Agent scenarios in CI and against live models | [Evals](docs/evals.md)                                                |

## Develop from source

```sh
nvm use
npm ci
npm run demo
```

The demo runs a catalog lookup without an API key. To run it against a live model, copy `.env.example` to `.env`, set your provider credentials and run `npm run demo:live`:

```dotenv
YADA_LLM_PROVIDER=anthropic
YADA_LLM_MODEL=claude-opus-5-5
YADA_LLM_API_KEY=your-anthropic-api-key
```

That is all Yada needs. `.env.example` also lists the optional settings (effort, temperature, prompt caching, provider-hosted web search and code execution) with their allowed values; see [configuration](docs/configuration.md#model-settings). Live requests use your provider account and may incur charges; keep `.env` private. For the full starter, run `npm run starter:init`, add credentials to `.env`, then `npm run starter`.

Before opening a pull request:

```sh
npx playwright install chromium
npm run check
npm run test:package
```

Automated tests require no provider credentials.

Storage tests also run against Postgres and MySQL when these URLs are set. Keep the databases in memory, since tests create and migrate a database each and that is many times slower on disk:

```bash
docker run -d --rm --name yada-test-pg --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=yada-test -e POSTGRES_DB=yada_test -p 55432:5432 postgres:17
docker run -d --rm --name yada-test-my --tmpfs /var/lib/mysql -e MYSQL_ROOT_PASSWORD=yada-test -e MYSQL_DATABASE=yada_test -p 53306:3306 mysql:8.4
export YADA_TEST_POSTGRES_URL=postgres://postgres:yada-test@127.0.0.1:55432/yada_test
export YADA_TEST_MYSQL_URL=mysql://root:yada-test@127.0.0.1:53306/yada_test
```

## Upgrading from 0.4

- The widget has a new default look: monochrome, with Yada's changing face in the header and on the empty screen, a single-line input and an icon send button. The title now defaults to "Yada". Set `avatar: false`, `composer`, `labels.title` and the `--yada-*` variables to change these, or `unstyled` to drop the styles.
- The approve button is now green and decline red. Set `--yada-approve` and `--yada-decline` to keep your own.
- Runs have a new failure code, `corrupt_record`. Handle it wherever you switch on failure codes. `Trace` has a new `record_quarantined` event.
- `BrowserClient` requests now time out after 15 seconds. Set `timeoutMs` to change it, or `0` for the old behavior.
- Run settings changed through getters now apply from the next run. Before, changing `limits` or the provider's name mid-run failed that run when it resumed.

## Upgrading from 0.3

- MCP schemas now enforce standard JSON Schema formats such as `uuid` and `date-time` on inputs, outputs and elicitation answers. A server output that fails its format after a write ran is treated as a possibly applied action and goes to reconciliation.
- Actions have a new `undelivered` status for writes that were never sent. Handle it wherever you switch on action status.
- Runs that exhaust their retries now add their cost to quotas.

## Upgrading from 0.2

- `better-sqlite3`, `pg`, `mysql2`, `@google/genai` (Gemini) and `@langchain/core` (`chatModelAdapter` from `@edgaralochi/yada/langchain`) are optional peer dependencies; install the ones you use.
- `@langchain/google-genai`, `@langchain/anthropic` and `@langchain/openai` are no longer used; Anthropic and OpenAI-compatible providers run on the official SDKs.
- `ReadTool.execute` returns `Content` (a string or an array of text and image parts) instead of `string`.
- Hosted `openai` always uses the Responses API; the `api` option and `YADA_LLM_OPENAI_API` are removed.
- Provider-hosted web search is on by default for `anthropic`, `openai` and `gemini` and is billed by the provider; set `YADA_LLM_SERVER_TOOLS=none` to turn it off.
- Every provider accepts every model setting and ignores ones it has no equivalent for (Anthropic ignores `temperature`; use `effort`).
- `chatModelAdapter` moved to `@edgaralochi/yada/langchain`, and `otelTracer` is only exported from `@edgaralochi/yada/otel`.
- Storage writes use a new encryption envelope with key ids (`v1` records stay readable) and an indexed `active` column; stop older Yada versions before upgrading, since they cannot read new records. Set `YADA_STORAGE_PREVIOUS_KEYS` to rotate keys without downtime.
- The service returns 400, 404, 410 and 415 for client errors instead of 503, and JSON endpoints require `Content-Type: application/json`.
- `maxFailures` counts consecutive rounds in which every tool call failed, and tools time out after `limits.toolTimeoutMs` (default 120,000).
- `maxContextChars` defaults to 256,000 and service `historyChars` to 128,000.
- `maxRounds` defaults to 32 and `maxToolCalls` to 64, also for `runDurable` and worker profiles. Set `maxCostMicros` to bound spend. Durable runs suspended before the upgrade fail with `Run configuration mismatch` on resume unless their profile pins the old `maxRounds: 8` and `maxToolCalls: 16`.

## License

[MIT](LICENSE)
