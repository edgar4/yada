# Runtime architecture

Yada is a server-side TypeScript runtime. Applications compose a model adapter and read tools through `src/index.ts`.

## Boundaries

- `core` owns normalized messages, tool contracts, authorization, and bounded execution. It cannot import concrete providers or application integrations.
- `providers` translate model SDK messages into the core contract. Model credentials stay on the server.
- Applications supply authenticated actor and tenant identity, tool authorization, and typed handlers. Browser-supplied identity must be verified before invoking Yada.

## Execution

Each run discovers authorized tools, invokes the provider, validates tool arguments, rechecks authorization, and returns tool results to the provider. Round and call limits bound execution. Invalid or truncated responses fail the run. Errors returned by dependencies are not exposed to callers.

Cancellation returns promptly even when a dependency ignores its signal. It cannot stop underlying work in that dependency; handlers must honor `AbortSignal`. Callers supply a deadline signal.

## Current capabilities

The runtime supports read tools, a scripted testing provider, and Anthropic, OpenAI, Gemini, DeepSeek, Ollama, and llama.cpp through LangChain. Tool input schemas use Zod and infer handler argument types. Provider tests cover SDK mappings and real SDK execution for hosted and local providers with mocked HTTP responses.

Each run keeps its messages in memory; messages are not persisted across process restarts.

## Development checks

Use Node 24 (`nvm use`), install with `npm ci`, and run `npm run check`. This checks formatting, typed lint rules, strict TypeScript, tests with coverage thresholds, and compilation. `npm run demo` exercises a tool round trip without credentials.
