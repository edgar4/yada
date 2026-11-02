import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyStarter } from "./starter-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "yada-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const execute = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

try {
  const packed = JSON.parse(
    execute(npm, ["pack", "--json", "--pack-destination", temporary], root),
  )[0];
  for (const { path } of packed.files)
    assert.match(
      path,
      /^(?:dist\/|docs\/|examples\/starter\/|README\.md$|LICENSE$|package\.json$)/,
    );
  assert(!packed.files.some(({ path }) => /(?:^|\/)\.env/.test(path)));
  assert(packed.files.some(({ path }) => path === "LICENSE"));
  for (const entry of [
    "index",
    "client/index",
    "widget/index",
    "entries/skills",
    "entries/providers",
    "entries/storage",
    "entries/mcp",
    "entries/service",
    "entries/otel",
  ])
    for (const extension of ["js", "d.ts"])
      assert(
        packed.files.some(({ path }) => path === `dist/${entry}.${extension}`),
        `Archive is missing dist/${entry}.${extension}`,
      );
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execute(
    npm,
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(temporary, packed.filename),
    ],
    temporary,
  );
  const manifest = JSON.parse(
    await readFile(
      join(temporary, "node_modules/@edgaralochi/yada/package.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.version, packed.version);
  await writeFile(
    join(temporary, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { createFakeProvider, createStorage, loadSkills, run } from "@edgaralochi/yada";
import { mkdir, writeFile } from "node:fs/promises";
import * as client from "@edgaralochi/yada/client";
import * as widget from "@edgaralochi/yada/widget";
import * as root from "@edgaralochi/yada";
import * as providers from "@edgaralochi/yada/providers";
import * as storageEntry from "@edgaralochi/yada/storage";
import * as mcp from "@edgaralochi/yada/mcp";
import * as skillsEntry from "@edgaralochi/yada/skills";
import * as service from "@edgaralochi/yada/service";
import * as otel from "@edgaralochi/yada/otel";
for (const entry of [providers, storageEntry, mcp, skillsEntry, service, otel])
  for (const key of Object.keys(entry)) assert.equal(entry[key], root[key], key);
assert(Object.keys(client).length > 0);
assert(Object.keys(widget).length > 0);
const provider = createFakeProvider(() => ({content: "installed", toolCalls: [], finishReason: "stop"}));
const result = await run({provider, tools: [], identity: {actorId: "test", tenantId: "test"}, input: "test", system: "test", signal: AbortSignal.timeout(5000)});
assert.deepEqual(result, {status: "completed", text: "installed"});
await mkdir("skills/installed", {recursive: true});
await writeFile("skills/installed/SKILL.md", ["---", "name: installed", "description: Verify packaged skills", "---", "Use the installed runtime."].join("\\n"));
const skills = await loadSkills({directories: ["skills"], authorize: async () => true});
assert.match(skills.system, /Verify packaged skills/);
assert.match(await skills.tools[0].execute({name: "installed"}, {actorId: "test", tenantId: "test"}, AbortSignal.timeout(5000)), /Use the installed runtime/);
await assert.rejects(createStorage({driver: "sqlite", filename: ":memory:", encryptionKey: "11".repeat(32)}), /npm install better-sqlite3/);
const gemini = root.createProvider({provider: "gemini", apiKey: "key"});
await assert.rejects(gemini.complete({system: "s", messages: [], tools: [], signal: AbortSignal.timeout(5000)}), /google-genai @langchain.core/);
await assert.rejects(otel.otelTracer(), /npm install @opentelemetry\\/api/);
`,
  );
  execute(process.execPath, ["smoke.mjs"], temporary);
  execute(
    npm,
    ["install", "--no-save", "--no-audit", "--no-fund", "better-sqlite3"],
    temporary,
  );
  await writeFile(
    join(temporary, "sqlite.mjs"),
    `
import assert from "node:assert/strict";
import { createStorage } from "@edgaralochi/yada/storage";
const storage = await createStorage({driver: "sqlite", filename: ":memory:", encryptionKey: "11".repeat(32)});
assert(storage);
await storage.close();
`,
  );
  execute(process.execPath, ["sqlite.mjs"], temporary);
  await writeFile(
    join(temporary, "types.ts"),
    `
import * as runtime from "@edgaralochi/yada";
import * as client from "@edgaralochi/yada/client";
import * as widget from "@edgaralochi/yada/widget";
import * as providers from "@edgaralochi/yada/providers";
import * as storage from "@edgaralochi/yada/storage";
import * as mcp from "@edgaralochi/yada/mcp";
import * as skills from "@edgaralochi/yada/skills";
import * as service from "@edgaralochi/yada/service";
import * as otel from "@edgaralochi/yada/otel";
void [runtime, client, widget, providers, storage, mcp, skills, service, otel];
`,
  );
  execute(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "types.ts",
    ],
    temporary,
  );
  const starter = join(temporary, "generated agent");
  execute(
    npm,
    ["exec", "--", "yada", "init", starter, "--no-install"],
    temporary,
  );
  const generated = JSON.parse(
    await readFile(join(starter, "package.json"), "utf8"),
  );
  assert.equal(generated.dependencies[packed.name], packed.version);
  assert.match(
    await readFile(join(starter, "skills/README.md"), "utf8"),
    /SKILL.md/,
  );
  assert.match(
    await readFile(join(starter, ".gitignore"), "utf8"),
    /\.env\.starter/,
  );
  execute(
    npm,
    ["install", "--no-audit", "--no-fund", join(temporary, packed.filename)],
    starter,
  );
  await cp(
    join(temporary, "skills/installed"),
    join(starter, "skills/installed"),
    { recursive: true },
  );
  await verifyStarter(starter, execute, npm);
  console.log(
    `Installed and verified ${packed.name}@${packed.version} and its standalone starter`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
