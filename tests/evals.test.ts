import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createFakeProvider } from "../src/index.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario, summarize } from "../evals/run.js";
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
}, 30_000);

const evalsScript = fileURLToPath(
  new URL("../scripts/evals.mjs", import.meta.url),
);
const cli = (args: string[], env: Record<string, string> = {}) =>
  promisify(execFile)(
    process.execPath,
    ["--import", "tsx", evalsScript, ...args],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );

it("aggregates pass rate, tokens and cost across runs", () => {
  const result = (pass: boolean, input: number) => ({
    name: "a",
    pass,
    failures: pass ? [] : ["bad"],
    inputTokens: input,
    outputTokens: 10,
  });
  expect(
    summarize(
      [
        result(true, 1000),
        result(false, 3000),
        { ...result(true, 1), name: "b" },
      ],
      { inputMicrosPer1k: 100, outputMicrosPer1k: 200 },
    ),
  ).toEqual([
    {
      scenario: "a",
      runs: 2,
      passes: 1,
      passRate: 0.5,
      inputTokens: 4000,
      outputTokens: 20,
      costMicros: 404,
      failures: ["bad"],
    },
    {
      scenario: "b",
      runs: 1,
      passes: 1,
      passRate: 1,
      inputTokens: 1,
      outputTokens: 10,
      costMicros: 2,
      failures: [],
    },
  ]);
  expect(summarize([result(true, 1)])[0]).not.toHaveProperty("costMicros");
});

it("repeats scenarios with --runs and writes JSON to --out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yada-evals-"));
  const out = join(dir, "results.json");
  await cli([
    "--provider",
    "fake",
    "--runs",
    "3",
    "--pricing",
    "100,200",
    "--out",
    out,
  ]);
  const report = JSON.parse(await readFile(out, "utf8")) as {
    provider: string;
    runs: number;
    scenarios: { runs: number; passRate: number; costMicros: number }[];
  };
  expect(report).toMatchObject({ provider: "fake", runs: 3 });
  expect(report.scenarios).toHaveLength(scenarios.length);
  for (const entry of report.scenarios)
    expect(entry).toMatchObject({ runs: 3, passRate: 1, costMicros: 0 });
}, 30_000);

it("exits 2 on invalid --runs or --pricing and 1 when a run fails", async () => {
  await expect(
    cli(["--provider", "fake", "--runs", "0"]),
  ).rejects.toMatchObject({ code: 2 });
  await expect(
    cli(["--provider", "fake", "--pricing", "1"]),
  ).rejects.toMatchObject({ code: 2 });
  await expect(
    cli(["--provider", "local", "--scenario", "multimodal"], {
      YADA_LLM_MODEL: "none",
      YADA_LLM_BASE_URL: "http://127.0.0.1:1/v1",
    }),
  ).rejects.toMatchObject({ code: 1 });
}, 30_000);
