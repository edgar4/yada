import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("generates private configuration once without printing secrets or overwriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yada-starter-init-"));
  try {
    const initialize = () =>
      promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL("../examples/starter/init.mjs", import.meta.url),
          ),
        ],
        { cwd: directory },
      );
    const result = await initialize();
    const filename = join(directory, ".env.starter");
    const contents = await readFile(filename, "utf8");
    expect(contents).toMatch(/YADA_STARTER_PASSWORD=[A-Za-z0-9_-]{32}\n/);
    expect(contents).toMatch(/YADA_STORAGE_KEY=[a-f0-9]{64}\n/);
    for (const line of contents
      .split("\n")
      .filter((value) => /PASSWORD|STORAGE_KEY/.test(value)))
      expect(result.stdout + result.stderr).not.toContain(line.split("=")[1]);
    if (process.platform !== "win32")
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
    await expect(initialize()).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe(contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
