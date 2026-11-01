import {
  run,
  type ProviderAdapter,
  type ProviderResult,
} from "../src/index.js";
import type { Scenario } from "./scenarios.js";

export type EvalResult = {
  name: string;
  pass: boolean;
  failures: string[];
  inputTokens: number;
  outputTokens: number;
};

const matches = (actual: unknown, expected: Record<string, unknown>) =>
  typeof actual === "object" &&
  actual !== null &&
  Object.entries(expected).every(
    ([key, value]) =>
      JSON.stringify((actual as Record<string, unknown>)[key]) ===
      JSON.stringify(value),
  );

export async function runScenario(
  scenario: Scenario,
  provider: ProviderAdapter,
  timeoutMs = 120_000,
): Promise<EvalResult> {
  const results: ProviderResult[] = [];
  const recording: ProviderAdapter = {
    name: provider.name,
    capabilities: provider.capabilities,
    complete: async (request) => {
      const result = await provider.complete(request);
      results.push(result);
      return result;
    },
  };
  const failures: string[] = [];
  try {
    const { tools, system, executeWrite } = await scenario.build();
    const outcome = await run({
      provider: recording,
      tools,
      identity: { actorId: "eval", tenantId: "eval" },
      input: scenario.input,
      system: system ?? "You are a concise assistant. Use the provided tools.",
      signal: AbortSignal.timeout(timeoutMs),
      ...(executeWrite ? { executeWrite } : {}),
    });
    const { expect } = scenario;
    if (outcome.status !== expect.status)
      failures.push(`status ${outcome.status}, expected ${expect.status}`);
    if (
      expect.text !== undefined &&
      !(
        outcome.status === "completed" &&
        outcome.text.toLowerCase().includes(expect.text.toLowerCase())
      )
    )
      failures.push(`final text lacks "${expect.text}"`);
    const made = results.flatMap((result) => result.toolCalls);
    for (const wanted of expect.calls ?? [])
      if (
        !made.some(
          (made) =>
            made.name === wanted.name &&
            (!wanted.args || matches(made.args, wanted.args)),
        )
      )
        failures.push(
          `no ${wanted.name} call${wanted.args ? ` with ${JSON.stringify(wanted.args)}` : ""}`,
        );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return {
    name: scenario.name,
    pass: !failures.length,
    failures,
    inputTokens: results.reduce(
      (sum, r) => sum + (r.usage?.inputTokens ?? 0),
      0,
    ),
    outputTokens: results.reduce(
      (sum, r) => sum + (r.usage?.outputTokens ?? 0),
      0,
    ),
  };
}
