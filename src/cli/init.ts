import { mkdir, readFile, copyFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestSchema = z.object({
  name: z.literal("@edgaralochi/yada"),
  version: z.string().min(1),
  engines: z.object({ node: z.string() }),
  files: z.array(z.string()),
  dependencies: z.object({ zod: z.string() }),
  devDependencies: z.object({ tsx: z.string(), esbuild: z.string() }),
});

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32" && command === "npm.cmd",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed; exit code ${String(code)}`));
    });
  });
}

export async function createStarter(directory: string) {
  const destination = resolve(directory);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  );
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        "Destination already exists; choose a new directory. Nothing changed.",
        { cause: error },
      );
    throw error;
  }
  try {
    await copyFile(join(packageRoot, "LICENSE"), join(destination, "LICENSE"));
    for (const file of manifest.files.filter((file) =>
      file.startsWith("examples/starter/"),
    )) {
      const relative = file.slice("examples/starter/".length);
      const target = join(
        destination,
        relative === "gitignore" ? ".gitignore" : relative,
      );
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(packageRoot, file), target);
    }
    await writeFile(
      join(destination, "package.json"),
      JSON.stringify(
        {
          name: "yada-agent",
          private: true,
          type: "module",
          engines: manifest.engines,
          scripts: {
            build: "node build.mjs",
            start:
              "npm run build && node --env-file=.env.starter --import tsx server.ts",
          },
          dependencies: {
            [manifest.name]: manifest.version,
            zod: manifest.dependencies.zod,
          },
          devDependencies: {
            tsx: manifest.devDependencies.tsx,
            esbuild: manifest.devDependencies.esbuild,
          },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    await runCommand(process.execPath, ["init.mjs"], destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return destination;
}
