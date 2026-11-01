import process from "node:process";
import {
  createFakeProvider,
  createProvider,
  providerConfigFromEnv,
} from "../src/index.ts";
import { runScenario } from "../evals/run.ts";
import { scenarios } from "../evals/scenarios.ts";

const index = process.argv.indexOf("--provider");
const name = index === -1 ? undefined : process.argv[index + 1];
if (!name || name.startsWith("--")) {
  console.error(
    "Usage: npm run evals -- --provider <fake|anthropic|openai|gemini|deepseek|local>",
  );
  process.exit(2);
}
if (name !== "fake" && process.env.CI) {
  console.error("Live evals are not allowed in CI");
  process.exit(2);
}
const selected = process.argv.includes("--scenario")
  ? scenarios.filter(
      (s) => s.name === process.argv[process.argv.indexOf("--scenario") + 1],
    )
  : scenarios;

const results = [];
for (const scenario of selected) {
  const provider =
    name === "fake"
      ? createFakeProvider(scenario.fake)
      : createProvider(
          providerConfigFromEnv({ ...process.env, YADA_LLM_PROVIDER: name }),
        );
  results.push(await runScenario(scenario, provider));
}
console.table(
  results.map((r) => ({
    scenario: r.name,
    result: r.pass ? "pass" : "FAIL",
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    failures: r.failures.join("; "),
  })),
);
process.exit(results.every((r) => r.pass) ? 0 : 1);
