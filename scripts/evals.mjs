import { writeFileSync } from "node:fs";
import process from "node:process";
import {
  createFakeProvider,
  createProvider,
  providerConfigFromEnv,
} from "../src/index.ts";
import { runScenario, summarize } from "../evals/run.ts";
import { scenarios } from "../evals/scenarios.ts";

const index = process.argv.indexOf("--provider");
const name = index === -1 ? undefined : process.argv[index + 1];
if (!name || name.startsWith("--")) {
  console.error(
    "Usage: npm run evals -- --provider <fake|anthropic|openai|gemini|deepseek|local> [--scenario <name>] [--runs <n>] [--pricing <inputMicrosPer1k,outputMicrosPer1k>] [--out <file>]",
  );
  process.exit(2);
}
if (
  name !== "fake" &&
  process.env.CI &&
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
) {
  console.error(
    "Live evals are not allowed in CI except manual workflow_dispatch",
  );
  process.exit(2);
}
const option = (flag) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};
const runs = Number(option("--runs") ?? 1);
if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs must be a positive integer");
  process.exit(2);
}
const pricingArg = option("--pricing");
const [inputMicrosPer1k, outputMicrosPer1k] = (pricingArg ?? "")
  .split(",")
  .map(Number);
if (
  pricingArg !== undefined &&
  !(inputMicrosPer1k >= 0 && outputMicrosPer1k >= 0)
) {
  console.error("--pricing must be <inputMicrosPer1k>,<outputMicrosPer1k>");
  process.exit(2);
}
const pricing =
  pricingArg === undefined
    ? undefined
    : { inputMicrosPer1k, outputMicrosPer1k };
const filter = process.argv.indexOf("--scenario");
const selected =
  filter === -1
    ? scenarios
    : scenarios.filter((s) => s.name === process.argv[filter + 1]);
if (!selected.length) {
  console.error("No scenario matches --scenario");
  process.exit(2);
}

const results = [];
for (let n = 0; n < runs; n++)
  for (const scenario of selected) {
    const provider =
      name === "fake"
        ? createFakeProvider(scenario.fake)
        : createProvider(
            providerConfigFromEnv({ ...process.env, YADA_LLM_PROVIDER: name }),
          );
    results.push(await runScenario(scenario, provider));
  }
const summary = summarize(results, pricing);
console.table(
  summary.map((r) => ({
    scenario: r.scenario,
    passRate: `${r.passes}/${r.runs}`,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    ...(pricing && { costMicros: r.costMicros }),
    failures: r.failures.join("; "),
  })),
);
const out = option("--out");
if (out)
  writeFileSync(
    out,
    JSON.stringify(
      {
        provider: name,
        model: process.env.YADA_LLM_MODEL,
        date: new Date().toISOString(),
        runs,
        scenarios: summary,
      },
      null,
      2,
    ),
  );
process.exit(results.every((r) => r.pass) ? 0 : 1);
