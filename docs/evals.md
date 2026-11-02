---
layout: doc
title: "Evals"
description: "Run fixture-based agent scenarios against the deterministic fake provider in CI or against a live model."
---

# Evals

Scenarios in `evals/scenarios.ts` describe an input, scripted tools, a deterministic fake-provider script and assertions: final status, final text and the tool calls the model made (arguments are matched by the keys you list). Shipped scenarios cover tool error self-correction, multiple tools, approval suspension, skill reads, truncated long output, reasoning replay across tool rounds, parallel reads and multimodal input. `input` is a string or content parts.

## CI

`tests/evals.test.ts` runs every scenario against the fake provider as part of `npm test`. No credentials or network are used.

## Live runs

```sh
npm run evals -- --provider anthropic
npm run evals -- --provider openai --scenario "skill read"
```

`--provider` is required: `fake`, `anthropic`, `openai`, `gemini`, `deepseek` or `local`. Credentials and model come from the `YADA_LLM_*` variables described in [provider configuration](configuration.md) (a `.env` file is loaded if present); `YADA_LLM_PROVIDER` is set from the flag. The script prints a pass/fail table with input and output tokens per scenario and exits non-zero on any failure or when `--scenario` matches nothing. Live mode refuses to run when `CI` is set and is never invoked by the test suite.

Options:

- `--runs N` repeats every scenario N times (default 1).
- `--pricing <inputMicrosPer1k>,<outputMicrosPer1k>` adds a cost column in micros, the same units as `limits.pricing` in [operations](operations.md). Cached tokens are priced as input.
- `--out <file>` writes the report as JSON: provider, `YADA_LLM_MODEL`, date, runs and per-scenario `passes`, `runs`, `passRate`, token totals, `costMicros` and distinct failures.

The exit code is 0 only when every run passed, 1 otherwise and 2 for invalid arguments.

To add a scenario, append to the `scenarios` array. Keep prompts explicit about which tool to use so live models behave predictably.

## Test your own agent

The runner is exported from `@edgaralochi/yada/evals`:

```ts
import { createFakeProvider } from "@edgaralochi/yada/providers";
import { runScenario, summarize, type Scenario } from "@edgaralochi/yada/evals";

const scenario: Scenario = {
  name: "greets",
  input: "Say hello",
  build: async () => ({ tools: [] }),
  fake: () => ({ content: "hello", toolCalls: [], finishReason: "stop" }),
  expect: { status: "completed", text: "hello" },
};
const result = await runScenario(scenario, createFakeProvider(scenario.fake));
console.table(summarize([result]));
```

Pass any provider from `createProvider` instead of the fake one to run against a live model.

## MCP server qualification

`scripts/qualify-mcp.mjs` connects to the servers listed in a JSON file, discovers tools, optionally makes one read call, lists resources and prompts, and reports pass/fail with latency per step. It exits 1 if any step fails.

```sh
npm run qualify:mcp -- evals/mcp-servers.example.json --out mcp-results.json
```

The file is an array of `{ "server": <MCP config>, "call"?: { "tool", "args" }, "prompts"?: true }`. `server` is a normal [MCP server config](mcp.md) (`command`/`args` or `url`, `headers`, `resources`); `resources: true` runs `list_resources`, `call.tool` is the bare tool name. The example file lists only the in-repo fixture. Keep files for public servers (for example `npx -y <server-package>` or a streamable HTTP `url`) and any credentials outside the repository; do not commit tokens.
