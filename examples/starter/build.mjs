import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL, pathToFileURL } from "node:url";

const output = pathToFileURL(resolve("work/starter/public") + "/");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("client.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("client.js", output)),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
});
for (const name of ["index.html", "style.css"])
  await copyFile(
    new URL(`public/${name}`, import.meta.url),
    new URL(name, output),
  );
