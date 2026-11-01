---
layout: doc
title: "Evals"
description: "Run fixture-based agent scenarios against the deterministic fake provider in CI or against a live model."
---

# Evals

Scenarios in `evals/scenarios.ts` describe an input, scripted tools, a deterministic fake-provider script and assertions: final status, final text and the tool calls the model made (arguments are matched by the keys you list). Shipped scenarios cover tool error self-correction, multiple tools, approval suspension, skill reads and truncated long output.

## CI

`tests/evals.test.ts` runs every scenario against the fake provider as part of `npm test`. No credentials or network are used.

## Live runs

```sh
npm run evals -- --provider anthropic
npm run evals -- --provider openai --scenario "skill read"
```

`--provider` is required: `fake`, `anthropic`, `openai`, `gemini`, `deepseek` or `local`. Credentials and model come from the `YADA_LLM_*` variables described in [provider configuration](configuration.md) (a `.env` file is loaded if present); `YADA_LLM_PROVIDER` is set from the flag. The script prints a pass/fail table with input and output tokens per scenario and exits non-zero on any failure or when `--scenario` matches nothing. Live mode refuses to run when `CI` is set and is never invoked by the test suite.

To add a scenario, append to the `scenarios` array. Keep prompts explicit about which tool to use so live models behave predictably.
