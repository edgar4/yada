import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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

it("fails when --scenario matches nothing", async () => {
  const run = (name: string) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../scripts/evals.mjs", import.meta.url)),
        "--provider",
        "fake",
        "--scenario",
        name,
      ],
      { encoding: "utf8" },
    );
  await expect(run("no such scenario")).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining("No scenario") as unknown,
  });
  await expect(run(scenarios[0]?.name ?? "")).resolves.toBeDefined();
});
