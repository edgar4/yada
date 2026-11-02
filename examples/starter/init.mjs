import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

const filename = ".env";
const template = await readFile(
  new URL(".env.example", import.meta.url),
  "utf8",
).catch(() => readFile(new URL("../../.env.example", import.meta.url), "utf8"));
const existing = await readFile(filename, "utf8").catch(() => undefined);
const storageKey = `YADA_STORAGE_KEY=${randomBytes(32).toString("hex")}\n`;
if (existing && /^YADA_STORAGE_KEY=\S/m.test(existing)) {
  console.error(".env already has YADA_STORAGE_KEY; nothing changed.");
  process.exitCode = 1;
} else {
  try {
    await writeFile(
      filename,
      existing === undefined
        ? `${template.trimEnd()}\n\n${storageKey}`
        : `${existing.trimEnd()}\n${storageKey}`,
      { mode: 0o600 },
    );
    console.log(
      existing === undefined
        ? "Created .env. Set YADA_LLM_API_KEY. Add YADA_STARTER_PASSWORD if you want password protection."
        : "Added YADA_STORAGE_KEY to .env.",
    );
  } catch {
    console.error("Could not write .env.");
    process.exitCode = 1;
  }
}
