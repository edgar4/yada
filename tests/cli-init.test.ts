import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createStarter } from "../src/cli/init.js";

it("copies every starter file except local data and renames gitignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "yada-cli-"));
  const stray = fileURLToPath(
    new URL("../examples/starter/stray.sqlite", import.meta.url),
  );
  try {
    await writeFile(stray, "");
    const directory = await createStarter(join(root, "agent"));
    const files = await readdir(directory, { recursive: true });
    expect(files).toEqual(
      expect.arrayContaining([
        ".gitignore",
        "tools.ts",
        join("public", "index.html"),
        join("skills", "README.md"),
      ]),
    );
    expect(files).not.toContain("gitignore");
    expect(files).not.toContain("stray.sqlite");
  } finally {
    await rm(stray, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
