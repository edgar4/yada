import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const targets = (
  process.argv[2] ?? "darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64"
).split(",");
const external = [
  "mariadb",
  "tedious",
  "oracledb",
  "sqlite3",
  "better-sqlite3",
  "mysql",
  "mysql2",
  "pg",
  "pg-query-stream",
  "pg-native",
  "@google/genai",
  "@langchain/core",
  "@opentelemetry/api",
];
const stub = {
  name: "stub-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "devtools",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

rmSync("dist-bin", { recursive: true, force: true });
for (const target of targets) {
  const windows = target.startsWith("windows");
  const directory = `dist-bin/yada-${target}`;
  mkdirSync(directory, { recursive: true });
  const result = await Bun.build({
    entrypoints: ["src/cli/index.ts"],
    compile: {
      target: `bun-${target}`,
      outfile: `${directory}/yada${windows ? ".exe" : ""}`,
    },
    minify: true,
    external,
    plugins: [stub],
    define: { "process.env.YADA_BUILD_VERSION": JSON.stringify(version) },
  });
  if (!result.success)
    throw new AggregateError(result.logs, `Build failed for ${target}`);
  const archive = `yada-${target}.${windows ? "zip" : "tar.gz"}`;
  if (windows)
    execFileSync("zip", ["-qj", `../${archive}`, "yada.exe"], {
      cwd: directory,
    });
  else
    execFileSync("tar", ["-czf", `../${archive}`, "yada"], { cwd: directory });
  console.log(`dist-bin/${archive}`);
}
