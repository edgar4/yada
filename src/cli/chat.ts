import { createInterface } from "node:readline";
import { styleText } from "node:util";
import type { Approval, CodingAgent } from "../coding/agent.js";
import type { AgentEvent } from "../core/hooks.js";
import { callSummary, failureText, help, resultSummary } from "./format.js";
import type { Commands } from "./coding.js";

const write = (text: string) => process.stdout.write(text);

export function colorDiff(preview: string) {
  return preview
    .split("\n")
    .map((line) =>
      line.startsWith("+") && !line.startsWith("+++")
        ? styleText("green", line)
        : line.startsWith("-") && !line.startsWith("---")
          ? styleText("red", line)
          : styleText("dim", line),
    )
    .join("\n");
}

export function printer() {
  let streamed = false;
  const onEvent = (event: AgentEvent) => {
    if (event.type === "text_delta") {
      streamed = true;
      write(event.delta);
    } else if (event.type === "tool_started")
      write(`\n${styleText("cyan", "●")} ${callSummary(event.call)}\n`);
    else if (event.type === "tool_finished")
      write(
        styleText(
          event.failed ? "red" : "dim",
          `  ⎿ ${resultSummary(event.content, event.failed)}\n`,
        ),
      );
  };
  return {
    onEvent,
    reset() {
      streamed = false;
    },
    get streamed() {
      return streamed;
    },
  };
}

export async function printOnce(
  agent: CodingAgent,
  prompt: string,
  out: ReturnType<typeof printer>,
) {
  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
  });
  const result = await agent.send(prompt, controller.signal);
  if (result.status === "completed") {
    if (!out.streamed) write(result.text);
    write("\n");
    return 0;
  }
  console.error(failureText("code" in result ? result.code : result.status));
  return 1;
}

export async function chat(
  agent: CodingAgent,
  out: ReturnType<typeof printer>,
  commands: Commands,
  initial?: string,
  input: NodeJS.ReadableStream = process.stdin,
) {
  let pending = initial;
  const rl = createInterface({ input, output: process.stdout });
  let controller: AbortController | undefined;
  let quitArmed = false;
  rl.on("SIGINT", () => {
    if (controller) {
      controller.abort();
      return;
    }
    if (quitArmed || !rl.line) rl.close();
    else {
      quitArmed = true;
      write("\n(press Ctrl+C again to quit)\n");
      rl.prompt();
    }
  });
  const lines: string[] = [];
  let waiting: ((line?: string) => void) | undefined;
  let closed = false;
  rl.on("line", (line) => {
    if (waiting) waiting(line);
    else lines.push(line);
  });
  rl.once("close", () => {
    closed = true;
    waiting?.();
  });
  const ask = (prompt: string, signal?: AbortSignal) => {
    if (lines.length || closed) return Promise.resolve(lines.shift());
    rl.setPrompt(prompt);
    rl.prompt();
    return new Promise<string | undefined>((done) => {
      waiting = (line) => {
        waiting = undefined;
        done(line);
      };
      signal?.addEventListener("abort", () => waiting?.(), { once: true });
    });
  };
  commands.approve = async ({ tool, preview }) => {
    write(`\n${colorDiff(preview)}\n`);
    const answer = (
      (await ask(
        styleText("yellow", `Allow ${tool}? [y]es / [n]o / [a]lways: `),
        controller?.signal,
      )) ?? ""
    )
      .trim()
      .toLowerCase();
    return ({ y: "yes", yes: "yes", a: "always", always: "always" }[answer] ??
      "no") as Approval;
  };
  write(
    styleText("bold", "Yada") +
      styleText(
        "dim",
        ` · ${agent.root} · mode ${agent.mode} · /help for commands\n`,
      ),
  );
  for (;;) {
    const line = pending ?? (await ask(styleText("cyan", "\n› ")));
    if (line === undefined) break;
    pending = undefined;
    quitArmed = false;
    const input = line.trim();
    if (!input) continue;
    if (input.startsWith("/")) {
      const reply = await commands.run(input, help);
      if (reply === null) break;
      write(`${reply}\n`);
      continue;
    }
    controller = new AbortController();
    out.reset();
    write("\n");
    try {
      const result = await agent.send(input, controller.signal);
      if (result.status === "completed") {
        if (!out.streamed) write(result.text);
        write("\n");
      } else
        write(
          styleText(
            "red",
            `\n${failureText("code" in result ? result.code : result.status)}\n`,
          ),
        );
    } catch (error) {
      write(
        styleText(
          "red",
          `\n${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
    } finally {
      controller = undefined;
    }
  }
  rl.close();
}
