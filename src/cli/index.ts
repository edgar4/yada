#!/usr/bin/env node
import { createStarter, runCommand } from "./init.js";

const usage =
  "Usage: yada init [directory] [--no-install]\nCreates a new standalone assistant (default directory: yada-app).";
try {
  const args = process.argv.slice(2);
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h"].includes(args[0] ?? ""))
  ) {
    console.log(usage);
  } else {
    if (process.versions.node.split(".")[0] !== "24")
      throw new Error("Yada requires Node 24.");
    const [command, ...rest] = args;
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    if (
      command !== "init" ||
      positional.length > 1 ||
      rest.some((arg) => arg.startsWith("-") && arg !== "--no-install") ||
      rest.filter((arg) => arg === "--no-install").length > 1
    )
      throw new Error(usage);
    const directory = await createStarter(positional[0] ?? "yada-app");
    if (!rest.includes("--no-install")) {
      try {
        await runCommand(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["install", "--no-audit", "--no-fund"],
          directory,
        );
      } catch (error) {
        throw new Error(
          `Starter created at ${directory}, but dependency installation failed. Run npm install in that directory to retry; your configuration has been retained.`,
          { cause: error },
        );
      }
    }
    console.log(
      `Created ${directory}. Set your provider credentials in .env.starter, then run ${rest.includes("--no-install") ? "npm install and " : ""}npm start from that directory.`,
    );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Unable to initialize Yada.",
  );
  process.exitCode = 1;
}
