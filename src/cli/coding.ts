import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createCodingAgent,
  defaultHome,
  listSessions,
  type Approval,
  type ApprovalRequest,
  type CodingAgent,
  type PermissionMode,
} from "../coding/agent.js";
import { createProvider, providerConfigFromEnv } from "../providers/config.js";
import { chat, printer, printOnce } from "./chat.js";
import { modes } from "./format.js";

export type Commands = {
  approve: (request: ApprovalRequest) => Promise<Approval>;
  run: (input: string, help: string) => Promise<string | null>;
};

export const codingUsage = `Usage: yada [prompt] [options]
Starts the coding agent in the current directory.
  -p, --print <prompt>  run one prompt, print the answer and exit
  -c, --continue        resume the latest session for this directory
  --resume <id>         resume a session by id
  --mode <mode>         ${modes.join(", ")} (default: ask)
  --plain               use the line interface instead of the full-screen one
Configure the model with YADA_LLM_PROVIDER, YADA_LLM_MODEL and YADA_LLM_API_KEY, in the environment or ~/.yada/.env.`;

export function commands(
  agent: CodingAgent,
  config: ReturnType<typeof providerConfigFromEnv>,
): Commands {
  return {
    approve: () => Promise.resolve("no"),
    async run(input, help) {
      const [name, ...rest] = input.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (name) {
        case "exit":
        case "quit":
          return null;
        case "help":
          return help;
        case "undo": {
          const paths = await agent.undo();
          return paths.length
            ? `Restored ${paths.join(", ")}.`
            : "No file changes to undo.";
        }
        case "clear":
          agent.clear();
          return "Started a new session.";
        case "mode":
          if (!modes.includes(arg as PermissionMode))
            return `Mode is ${agent.mode}. Choose one of: ${modes.join(", ")}`;
          agent.mode = arg as PermissionMode;
          return `Mode set to ${arg}.`;
        case "model":
          if (!arg) return "Usage: /model <name>";
          agent.provider = createProvider({ ...config, model: arg });
          return `Model set to ${arg}.`;
        case "resume": {
          const sessions = await agent.sessions();
          const chosen = sessions[Number(arg) - 1];
          if (chosen) {
            agent.resume(chosen);
            return `Resumed "${chosen.title}" (${String(chosen.messages.length)} messages).`;
          }
          return sessions.length
            ? sessions
                .slice(0, 20)
                .map(
                  (session, index) =>
                    `${String(index + 1)}. ${session.title || "(untitled)"} · ${session.updatedAt.slice(0, 16).replace("T", " ")}`,
                )
                .join("\n")
            : "No sessions for this directory.";
        }
        default:
          return `Unknown command /${name ?? ""}. Type /help.`;
      }
    },
  };
}

export async function startCoding(argv: readonly string[]) {
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
          print: { type: "string", short: "p" },
          continue: { type: "boolean", short: "c" },
          resume: { type: "string" },
          mode: { type: "string" },
          plain: { type: "boolean" },
        },
      });
    } catch {
      throw new Error(codingUsage);
    }
  })();
  const mode = (values.mode ??
    (values.print ? "read-only" : "ask")) as PermissionMode;
  if (!modes.includes(mode)) throw new Error(codingUsage);
  const envFile = join(defaultHome(), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = providerConfigFromEnv(process.env);
  const root = process.cwd();
  const sessions =
    values.continue || values.resume ? await listSessions(root) : [];
  const session = values.resume
    ? sessions.find((item) => item.id === values.resume)
    : sessions[0];
  if (values.resume && !session)
    throw new Error(`No session ${values.resume} for this directory`);
  const out = printer();
  const ref: { handlers?: Commands } = {};
  let listener: Parameters<typeof createCodingAgent>[0]["onEvent"] =
    out.onEvent;
  const agent = await createCodingAgent({
    root,
    provider: createProvider(config),
    mode,
    ...(session ? { session } : {}),
    approve: (request) =>
      ref.handlers?.approve(request) ?? Promise.resolve("no"),
    onEvent: (event) => listener?.(event),
  });
  const handlers = (ref.handlers = commands(agent, config));
  const prompt =
    values.print ?? (positionals.length ? positionals.join(" ") : undefined);
  if (values.print !== undefined || (prompt && !process.stdin.isTTY))
    return printOnce(agent, prompt ?? "", out);
  if (!values.plain && process.stdout.isTTY && process.stdin.isTTY) {
    const tui = await import("./tui.js").catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_MODULE_NOT_FOUND"
      )
        return undefined;
      throw error;
    });
    if (tui) {
      listener = undefined;
      await tui.runTui(agent, handlers, prompt, (next) => {
        listener = next;
      });
      return 0;
    }
  }
  await chat(agent, out, handlers, prompt);
  return 0;
}
