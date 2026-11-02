import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { connectMcp } from "../src/index.ts";

const [file, ...flags] = process.argv.slice(2);
if (!file || file.startsWith("--")) {
  console.error("Usage: npm run qualify:mcp -- <servers.json> [--out <file>]");
  process.exit(2);
}
const outAt = flags.indexOf("--out");
const out = outAt === -1 ? undefined : flags[outAt + 1];
let entries;
try {
  entries = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(entries) || !entries.length) throw new Error();
} catch {
  console.error("Servers file must be a non-empty JSON array");
  process.exit(2);
}

const identity = { actorId: "qualify", tenantId: "qualify" };
const access = { identity, authorize: () => Promise.resolve(true) };
const timed = async (action) => {
  const started = Date.now();
  try {
    const detail = await action();
    return { ok: true, ms: Date.now() - started, detail };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};
const text = (content) =>
  typeof content === "string" ? content : JSON.stringify(content);

const results = [];
for (const { server, call, prompts } of entries) {
  const result = { server: server?.name, steps: {} };
  results.push(result);
  let connection;
  result.steps.connect = await timed(async () => {
    connection = await connectMcp(
      server,
      access,
      AbortSignal.timeout(server?.timeoutMs ?? 30_000),
    );
    if (!connection.tools.length) throw new Error("No tools discovered");
    return `${connection.tools.length} tools`;
  });
  if (!connection) continue;
  const tool = (name) =>
    connection.tools.find((t) => t.spec.name === `${server.name}__${name}`);
  const invoke = async (name, args) => {
    const found = tool(name);
    if (!found) throw new Error(`Tool ${name} not found`);
    return text(
      await found.execute(
        args ?? {},
        identity,
        AbortSignal.timeout(server.timeoutMs ?? 30_000),
      ),
    ).slice(0, 200);
  };
  if (call) result.steps.call = await timed(() => invoke(call.tool, call.args));
  if (server.resources)
    result.steps.resources = await timed(() => invoke("list_resources"));
  if (prompts)
    result.steps.prompts = await timed(async () => {
      const found = await connection.prompts(identity);
      return `${found.length} prompts`;
    });
  await connection.close().catch(() => undefined);
}

const passed = (result) => Object.values(result.steps).every((step) => step.ok);
console.table(
  results.map((result) => ({
    server: result.server,
    result: passed(result) ? "pass" : "FAIL",
    ...Object.fromEntries(
      Object.entries(result.steps).map(([name, step]) => [
        name,
        `${step.ok ? "ok" : "FAIL"} ${step.ms}ms`,
      ]),
    ),
    failures: Object.entries(result.steps)
      .filter(([, step]) => !step.ok)
      .map(([name, step]) => `${name}: ${step.detail}`)
      .join("; "),
  })),
);
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(results.every(passed) ? 0 : 1);
