import { expect, it } from "vitest";
import { createFakeProvider } from "../src/index.js";
import { runScenario } from "../evals/run.js";
import { scenarios } from "../evals/scenarios.js";

for (const scenario of scenarios)
  it(`eval: ${scenario.name}`, async () => {
    const result = await runScenario(
      scenario,
      createFakeProvider(scenario.fake),
    );
    expect(result.failures).toEqual([]);
  });

it("reports failed assertions", async () => {
  const [scenario] = scenarios;
  if (!scenario) throw new Error("No scenarios");
  const result = await runScenario(
    scenario,
    createFakeProvider(() => ({
      content: "nope",
      toolCalls: [],
      finishReason: "stop",
    })),
  );
  expect(result.pass).toBe(false);
  expect(result.failures).toHaveLength(3);
});
