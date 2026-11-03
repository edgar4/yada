import { build } from "esbuild";
import { fileURLToPath, URL } from "node:url";

await build({
  stdin: {
    contents:
      'export * from "./src/client/index.ts"; export * from "./src/widget/index.ts";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  globalName: "Yada",
  target: "es2022",
  minify: true,
  outfile: "dist/yada-widget.js",
});
