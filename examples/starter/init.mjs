import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import console from "node:console";

const filename = ".env.starter";
try {
  await writeFile(
    filename,
    [
      "YADA_LLM_PROVIDER=anthropic",
      "YADA_LLM_MODEL=claude-sonnet-4-6",
      "YADA_LLM_API_KEY=",
      `YADA_STORAGE_KEY=${randomBytes(32).toString("hex")}`,
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created .env.starter. Set your provider credentials. Add YADA_STARTER_PASSWORD if you want password protection.",
  );
} catch (error) {
  console.error(
    error?.code === "EEXIST"
      ? ".env.starter already exists; nothing changed."
      : "Could not create .env.starter.",
  );
  process.exitCode = 1;
}
