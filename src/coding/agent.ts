import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ActionExecutor } from "../core/action.js";
import type { RunCheckpoint } from "../core/checkpoint.js";
import type {
  Content,
  ProviderAdapter,
  RunResult,
  Tool,
  Turn,
} from "../core/contracts.js";
import type { AgentEvent } from "../core/hooks.js";
import { run } from "../core/runtime.js";
import { loadSkills } from "../skills/index.js";
import { codingSystem } from "./context.js";
import { codingTools } from "./tools.js";

export type PermissionMode = "ask" | "auto-edit" | "auto" | "read-only";
export type Approval = "yes" | "no" | "always";
export type ApprovalRequest = Readonly<{ tool: string; preview: string }>;
export type Session = {
  id: string;
  root: string;
  title: string;
  updatedAt: string;
  messages: Turn[];
};

const sessionsDir = (home: string) => join(home, "sessions");
const identity = { actorId: userInfo().username, tenantId: "local" };
const allow = () => Promise.resolve(true);

export async function listSessions(root: string, home = defaultHome()) {
  const files = await readdir(sessionsDir(home)).catch(() => []);
  const sessions = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(
        async (file) =>
          JSON.parse(
            await readFile(join(sessionsDir(home), file), "utf8"),
          ) as Session,
      ),
  );
  return sessions
    .filter((session) => session.root === resolve(root))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function defaultHome() {
  return process.env["YADA_HOME"] ?? join(homedir(), ".yada");
}

export function settled(messages: readonly Turn[]): Turn[] {
  const answered = new Set(
    messages.flatMap((turn) => (turn.role === "tool" ? [turn.toolCallId] : [])),
  );
  const broken = messages.findIndex(
    (turn) =>
      turn.role === "assistant" &&
      turn.toolCalls.some((call) => !answered.has(call.id)),
  );
  return broken === -1 ? [...messages] : messages.slice(0, broken);
}

export async function createCodingAgent(options: {
  root: string;
  provider: ProviderAdapter;
  approve: (request: ApprovalRequest) => Promise<Approval>;
  onEvent?: (event: AgentEvent) => void;
  mode?: PermissionMode;
  session?: Session;
  home?: string;
  tools?: readonly Tool[];
}) {
  const root = resolve(options.root);
  const home = options.home ?? defaultHome();
  const skills = await loadSkills({
    directories: [
      join(root, ".claude", "skills"),
      join(root, ".agents", "skills"),
      join(home, "skills"),
    ],
    authorize: allow,
  });
  const system = [await codingSystem(root), skills.system]
    .filter(Boolean)
    .join("\n\n");
  const tools = [
    ...codingTools({ root }),
    ...skills.tools,
    ...(options.tools ?? []),
  ];
  const allowed = new Set<string>();
  const changes: { path: string; before: string | undefined }[][] = [];
  let note = "";
  let mode = options.mode ?? "ask";
  let provider = options.provider;
  let session: Session = options.session ?? fresh();
  function fresh(): Session {
    return {
      id: randomUUID(),
      root,
      title: "",
      updatedAt: new Date().toISOString(),
      messages: [],
    };
  }
  const executeWrite: ActionExecutor = async (tool, call, signal) => {
    try {
      const { preview, version } = await tool.prepare(
        call.args,
        identity,
        signal,
      );
      const automatic =
        allowed.has(tool.spec.name) ||
        mode === "auto" ||
        (mode === "auto-edit" && tool.spec.name !== "bash");
      const answer = automatic
        ? "yes"
        : await options.approve({ tool: tool.spec.name, preview });
      if (answer === "always") allowed.add(tool.spec.name);
      if (answer === "no")
        return JSON.stringify({
          error: "denied",
          message:
            "The user declined this action. Ask what to do instead before trying again.",
        });
      if (["edit_file", "write_file"].includes(tool.spec.name)) {
        const path = resolve(root, (call.args as { path: string }).path);
        changes.at(-1)?.push({
          path,
          before: await readFile(path, "utf8").catch(() => undefined),
        });
      }
      return await tool.execute(call.args, {
        identity,
        signal,
        operationId: call.id,
        version,
      });
    } catch (error) {
      signal.throwIfAborted();
      return JSON.stringify({
        error: "tool_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const save = async () => {
    session.updatedAt = new Date().toISOString();
    await mkdir(sessionsDir(home), { recursive: true });
    await writeFile(
      join(sessionsDir(home), `${session.id}.json`),
      JSON.stringify(session),
      { mode: 0o600 },
    );
  };
  return {
    root,
    sessions: () => listSessions(root, home),
    get session() {
      return session;
    },
    get mode() {
      return mode;
    },
    set mode(next: PermissionMode) {
      mode = next;
    },
    get provider() {
      return provider;
    },
    set provider(next: ProviderAdapter) {
      provider = next;
    },
    resume(next: Session) {
      session = next;
      allowed.clear();
      changes.length = 0;
    },
    clear() {
      session = fresh();
      allowed.clear();
      changes.length = 0;
    },
    async undo() {
      let group = changes.pop();
      while (group?.length === 0) group = changes.pop();
      if (!group) return [];
      for (const { path, before } of [...group].reverse())
        if (before === undefined) await rm(path, { force: true });
        else await writeFile(path, before);
      const paths = [...new Set(group.map(({ path }) => relative(root, path)))];
      note += `[The user reverted your file changes from an earlier turn to: ${paths.join(", ")}]\n`;
      return paths;
    },
    async send(input: Content, signal: AbortSignal): Promise<RunResult> {
      if (!session.title && typeof input === "string")
        session.title = input.slice(0, 80);
      if (note && typeof input === "string") {
        input = note + input;
        note = "";
      }
      changes.push([]);
      let last: RunCheckpoint | undefined;
      const result = await run({
        provider,
        tools:
          mode === "read-only"
            ? tools.filter((tool) => tool.effect === "read")
            : tools,
        identity,
        input,
        system,
        signal,
        history: session.messages,
        executeWrite,
        limits: { maxRounds: 200, maxToolCalls: 500, maxFailures: 10 },
        summarize: {},
        hooks: {
          onEvent: (event) => {
            options.onEvent?.(event);
            return undefined;
          },
        },
        persist: (checkpoint) => {
          last = checkpoint;
          return Promise.resolve();
        },
      });
      session.messages = settled(
        last?.messages ?? [
          ...session.messages,
          { role: "user", content: input },
        ],
      );
      if (
        result.status === "completed" &&
        session.messages.at(-1)?.role !== "assistant"
      )
        session.messages.push({
          role: "assistant",
          content: result.text,
          toolCalls: [],
        });
      await save();
      return result;
    },
  };
}

export type CodingAgent = Awaited<ReturnType<typeof createCodingAgent>>;
