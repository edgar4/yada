import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { qualifyMcp } from "../src/cli/qualify-mcp.js";

const example = JSON.parse(
  await readFile("evals/mcp-servers.example.json", "utf8"),
) as { call: object }[];
const qualify = async (servers: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), "yada-qualify-"));
  const file = join(dir, "servers.json");
  await writeFile(file, JSON.stringify(servers));
  const out = join(dir, "out.json");
  vi.spyOn(console, "table").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return { code: await qualifyMcp([file, "--out", out]), out };
};

it("qualifies the in-repo fixture server", async () => {
  const { code, out } = await qualify(example);
  expect(code).toBe(0);
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
  expect((await qualify([{ ...entry, call: { tool: "missing" } }])).code).toBe(
    1,
  );
  expect((await qualify({})).code).toBe(2);
  expect(await qualifyMcp([])).toBe(2);
}, 30_000);
