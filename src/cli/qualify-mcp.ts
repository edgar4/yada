import { readFileSync, writeFileSync } from "node:fs";
import {
  connectMcp,
  type McpConnection,
  type McpReadConfig,
  type Tool,
} from "../index.js";
import { exposedToolName } from "../connectors/mcp/session.js";

type Entry = {
  server: McpReadConfig;
  call?: { tool: string; args?: unknown };
  prompts?: boolean;
};
type Step = { ok: boolean; ms: number; detail: unknown };

export const qualifyUsage =
  "Usage: yada qualify-mcp <servers.json> [--out <file>]";

export async function qualifyMcp(args: string[]): Promise<number> {
  const [file, ...flags] = args;
  if (!file || file.startsWith("--")) {
    console.error(qualifyUsage);
    return 2;
  }
  const outAt = flags.indexOf("--out");
  const out = outAt === -1 ? undefined : flags[outAt + 1];
  let entries: Entry[];
  try {
    entries = JSON.parse(readFileSync(file, "utf8")) as Entry[];
    if (!Array.isArray(entries) || !entries.length) throw new Error();
  } catch {
    console.error("Servers file must be a non-empty JSON array");
    return 2;
  }

  const identity = { actorId: "qualify", tenantId: "qualify" };
  const access = { identity, authorize: () => Promise.resolve(true) };
  const timed = async (action: () => Promise<unknown>): Promise<Step> => {
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
  const text = (content: unknown) =>
    typeof content === "string" ? content : JSON.stringify(content);

  const results: { server: string | undefined; steps: Record<string, Step> }[] =
    [];
  for (const { server, call, prompts } of entries) {
    const result: (typeof results)[number] = {
      server: server.name,
      steps: {},
    };
    results.push(result);
    const timeout = server.timeoutMs ?? 30_000;
    let connection: McpConnection | undefined;
    result.steps["connect"] = await timed(async () => {
      connection = await connectMcp(
        server,
        access,
        AbortSignal.timeout(timeout),
      );
      if (!connection.tools.length) throw new Error("No tools discovered");
      return `${String(connection.tools.length)} tools`;
    });
    if (!connection) continue;
    const open = connection;
    const invoke = async (name: string, toolArgs?: unknown) => {
      const exposed = exposedToolName(server.name, name);
      const found = (open.tools as readonly Tool[]).find(
        (tool) => tool.spec.name === exposed,
      );
      if (!found) throw new Error(`Tool ${name} not found`);
      const signal = AbortSignal.timeout(timeout);
      const result =
        found.effect === "write"
          ? await found.execute(toolArgs ?? {}, {
              identity,
              signal,
              operationId: "qualify",
              version: found.version,
            })
          : await found.execute(toolArgs ?? {}, identity, signal);
      return text(result).slice(0, 200);
    };
    if (call)
      result.steps["call"] = await timed(() => invoke(call.tool, call.args));
    if (server.resources)
      result.steps["resources"] = await timed(() => invoke("list_resources"));
    if (prompts)
      result.steps["prompts"] = await timed(async () => {
        const found = await open.prompts(identity);
        return `${String(found.length)} prompts`;
      });
    await open.close().catch(() => undefined);
  }

  const passed = (result: (typeof results)[number]) =>
    Object.values(result.steps).every((step) => step.ok);
  console.table(
    results.map((result) => ({
      server: result.server,
      result: passed(result) ? "pass" : "FAIL",
      ...Object.fromEntries(
        Object.entries(result.steps).map(([name, step]) => [
          name,
          `${step.ok ? "ok" : "FAIL"} ${String(step.ms)}ms`,
        ]),
      ),
      failures: Object.entries(result.steps)
        .filter(([, step]) => !step.ok)
        .map(([name, step]) => `${name}: ${String(step.detail)}`)
        .join("; "),
    })),
  );
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  return results.every(passed) ? 0 : 1;
}
