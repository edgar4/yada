import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      /^(?:dist\/|docs\/|README\.md$|LICENSE$|package\.json$)/,
    );
  assert(packed.files.some(({ path }) => path === "LICENSE"));
  for (const entry of ["index", "client/index", "widget/index"])
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
import { createFakeProvider, createStorage, run } from "@edgaralochi/yada";
import * as client from "@edgaralochi/yada/client";
import * as widget from "@edgaralochi/yada/widget";
assert(Object.keys(client).length > 0);
assert(Object.keys(widget).length > 0);
const provider = createFakeProvider(() => ({content: "installed", toolCalls: [], finishReason: "stop"}));
const result = await run({provider, tools: [], identity: {actorId: "test", tenantId: "test"}, input: "test", system: "test", signal: AbortSignal.timeout(5000)});
assert.deepEqual(result, {status: "completed", text: "installed"});
const storage = await createStorage({driver: "sqlite", filename: ":memory:", encryptionKey: "11".repeat(32)});
await storage.close();
`,
  );
  execute(process.execPath, ["smoke.mjs"], temporary);
  await writeFile(
    join(temporary, "types.ts"),
    `
import * as runtime from "@edgaralochi/yada";
import * as client from "@edgaralochi/yada/client";
import * as widget from "@edgaralochi/yada/widget";
void [runtime, client, widget];
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
  await verifyStarter(root, temporary, execute, npm);
  console.log(
    `Installed and verified ${packed.name}@${packed.version} and its standalone starter`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
