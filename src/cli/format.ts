import type { ToolCall } from "../core/contracts.js";

export const modes = ["ask", "auto-edit", "auto", "read-only"] as const;

export const help = `Commands:
  /clear            start a new session
  /undo             revert the file edits from the latest turn that made any
  /resume [n]       list sessions for this project, or resume number n
  /mode <mode>      ${modes.join(", ")}
  /model <name>     switch model
  /exit             quit
Ctrl+C stops the current turn; press it again on an empty prompt to quit.`;

export function callSummary(call: ToolCall) {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const main = ["command", "path", "pattern", "name"]
    .map((key) => args[key])
    .find((value) => typeof value === "string");
  const text = typeof main === "string" ? main : JSON.stringify(args);
  return `${call.name}(${text.length > 80 ? `${text.slice(0, 79)}…` : text})`;
}

export function resultSummary(content: string, failed: boolean) {
  if (failed || content.startsWith('{"error"'))
    return (/"message":"([^"]*)"/.exec(content)?.[1] ?? content).slice(0, 200);
  const lines = content.trimEnd().split("\n");
  return lines.length > 1
    ? `${String(lines.length)} lines`
    : (lines[0] ?? "").slice(0, 120);
}

export function failureText(code: string) {
  return code === "cancelled" ? "Stopped." : `The run failed: ${code}.`;
}
