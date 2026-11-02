import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const example = JSON.parse(
  await readFile("evals/mcp-servers.example.json", "utf8"),
) as { call: object }[];
const qualify = async (servers: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), "yada-qualify-"));
  const file = join(dir, "servers.json");
  await writeFile(file, JSON.stringify(servers));
  const out = join(dir, "out.json");
  const run = promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "scripts/qualify-mcp.mjs", file, "--out", out],
    { encoding: "utf8" },
  );
  return { run, out };
};

it("qualifies the in-repo fixture server", async () => {
  const { run, out } = await qualify(example);
  await run;
  const [result] = JSON.parse(await readFile(out, "utf8")) as {
    server: string;
    steps: Record<string, { ok: boolean; ms: number }>;
  }[];
  expect(result?.server).toBe("fixture");
  expect(result?.steps["connect"]).toMatchObject({ ok: true });
  expect(result?.steps["call"]).toMatchObject({ ok: true });
  expect(result?.steps["call"]?.ms).toBeGreaterThanOrEqual(0);
}, 30_000);

it("exits 1 when a step fails and 2 on a bad servers file", async () => {
  const [entry] = example;
  const { run } = await qualify([{ ...entry, call: { tool: "missing" } }]);
  await expect(run).rejects.toMatchObject({ code: 1 });
  const bad = await qualify({});
  await expect(bad.run).rejects.toMatchObject({ code: 2 });
}, 30_000);
