import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
  copyFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createStarter, runCommand } from "../src/cli/init.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, copyFile: vi.fn(original.copyFile) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(copyFile).mockClear();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yada-initializer-"));
  roots.push(root);
  return root;
}
const entry = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const cli = (cwd: string, args: readonly string[], env = process.env) =>
  promisify(execFile)(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), entry, ...args],
    {
      cwd,
      env,
    },
  );

it("creates the existing starter, private config, skills directory and pinned dependencies", async () => {
  const root = await fixture();
  const target = join(root, "my assistant");
  expect(await createStarter(target)).toBe(target);
  const env = await readFile(join(target, ".env.starter"), "utf8");
  expect(env).toContain("YADA_LLM_API_KEY=\n");
  expect(env).toMatch(/YADA_STORAGE_KEY=[a-f0-9]{64}\n/);
  expect(env).not.toContain("PASSWORD");
  if (process.platform !== "win32")
    expect((await stat(join(target, ".env.starter"))).mode & 0o777).toBe(0o600);
  const original = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(
    JSON.parse(await readFile(join(target, "package.json"), "utf8")),
  ).toMatchObject({
    private: true,
    type: "module",
    dependencies: { "@edgaralochi/yada": original.version },
    scripts: {
      build: "node build.mjs",
      start:
        "npm run build && node --env-file=.env.starter --import tsx server.ts",
    },
  });
  expect(await readFile(join(target, "app.ts"), "utf8")).toBe(
    await readFile(
      new URL("../examples/starter/app.ts", import.meta.url),
      "utf8",
    ),
  );
  expect(await readFile(join(target, ".gitignore"), "utf8")).toContain(
    ".env.starter",
  );
  expect(await readFile(join(target, "skills/README.md"), "utf8")).toContain(
    "SKILL.md",
  );
  expect(await readFile(join(target, "LICENSE"), "utf8")).toContain(
    "MIT License",
  );
  const before = await readdir(target);
  await expect(createStarter(target)).rejects.toThrow("already exists");
  expect(await readdir(target)).toEqual(before);
  expect(await readFile(join(target, ".env.starter"), "utf8")).toBe(env);
});

it("never replaces an existing file or follows a destination symlink", async () => {
  const root = await fixture();
  const file = join(root, "existing");
  await writeFile(file, "keep me");
  await expect(createStarter(file)).rejects.toThrow("already exists");
  expect(await readFile(file, "utf8")).toBe("keep me");
  if (process.platform !== "win32") {
    const link = join(root, "linked");
    await symlink(root, link);
    await expect(createStarter(link)).rejects.toThrow("already exists");
    expect(await readFile(file, "utf8")).toBe("keep me");
  }
  await expect(createStarter(join(root, "missing", "child"))).rejects.toThrow();
});

it("removes only the newly created directory if scaffolding fails", async () => {
  const root = await fixture();
  await writeFile(join(root, "keep.txt"), "preserved");
  vi.mocked(copyFile).mockRejectedValueOnce(new Error("Copy failed"));
  await expect(createStarter(join(root, "broken"))).rejects.toThrow(
    "Copy failed",
  );
  expect(await readdir(root)).toEqual(["keep.txt"]);
});

it.each([[], ["--help"], ["-h"]])(
  "prints help without creating files: %j",
  async (...args) => {
    const root = await fixture();
    const result = await cli(root, args);
    expect(result.stdout).toContain("yada init");
    expect(await readdir(root)).toEqual([]);
  },
);

it.each([
  ["unknown"],
  ["init", "--force"],
  ["init", "a", "b"],
  ["init", "--no-install", "--no-install"],
])("rejects invalid arguments without changing files: %j", async (...args) => {
  const root = await fixture();
  await expect(cli(root, args)).rejects.toThrow("Usage: yada init");
  expect(await readdir(root)).toEqual([]);
});

it("supports the default directory and skips installation without exposing generated secrets", async () => {
  const root = await fixture();
  const result = await cli(root, ["init", "--no-install"]);
  const env = await readFile(join(root, "yada-app/.env.starter"), "utf8");
  const key = /YADA_STORAGE_KEY=(\w+)/.exec(env)?.[1];
  expect(key).toBeTruthy();
  expect(result.stdout + result.stderr).not.toContain(key);
  expect(result.stdout).toContain("npm install and npm start");
  expect(await readdir(join(root, "yada-app"))).not.toContain("node_modules");
});

it.skipIf(process.platform === "win32")(
  "installs dependencies by default and preserves config when installation fails",
  async () => {
    const root = await fixture();
    const bin = join(root, "bin");
    await mkdir(bin);
    const npm = join(bin, "npm");
    await writeFile(npm, "#!/usr/bin/env node\nprocess.exit(42);\n", {
      mode: 0o700,
    });
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
    };
    await expect(cli(root, ["init", "failed"], env)).rejects.toThrow(
      "configuration has been retained",
    );
    expect(await readFile(join(root, "failed/.env.starter"), "utf8")).toContain(
      "YADA_STORAGE_KEY=",
    );
    await writeFile(
      npm,
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("installed.json", JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o700 },
    );
    await cli(root, ["init", "installed"], env);
    expect(
      JSON.parse(
        await readFile(join(root, "installed/installed.json"), "utf8"),
      ),
    ).toEqual(["install", "--no-audit", "--no-fund"]);
  },
);

it("reports process failures", async () => {
  const root = await fixture();
  await expect(
    runCommand(process.execPath, ["-e", "process.exit(7)"], root),
  ).rejects.toThrow("exit code 7");
  await expect(
    runCommand(join(root, "missing-command"), [], root),
  ).rejects.toThrow();
});
