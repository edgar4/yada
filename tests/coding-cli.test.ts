import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCodingAgent, createFakeProvider } from "../src/index.js";
import type { ProviderResult } from "../src/index.js";
import { chat, colorDiff, printer, printOnce } from "../src/cli/chat.js";
import { commands, startCoding } from "../src/cli/coding.js";

vi.mock("../src/cli/tui.js", () => ({
  runTui: vi.fn(
    (
      _agent: unknown,
      _handlers: unknown,
      prompt: string | undefined,
      subscribe: (listener: (event: { type: string }) => void) => void,
    ) => {
      subscribe(() => undefined);
      output += `tui:${prompt ?? ""}`;
      return Promise.resolve();
    },
  ),
}));
const say = (content: string): ProviderResult => ({
  content,
  toolCalls: [],
  finishReason: "stop",
});
let root: string;
let output: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "yada-cli-"));
  vi.stubEnv("YADA_HOME", await mkdtemp(join(tmpdir(), "yada-home-")));
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("chats, approves tools and runs commands in the line interface", async () => {
  const provider = createFakeProvider((_request, n) =>
    n === 1
      ? {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: "write_file",
              args: { path: "a.txt", content: "hi" },
            },
          ],
          finishReason: "tool_calls",
        }
      : say("done"),
  );
  const out = printer();
  const agent = await createCodingAgent({
    root,
    provider,
    approve: (request) => handlers.approve(request),
    onEvent: out.onEvent,
  });
  const handlers = commands(agent, {
    provider: "ollama",
    model: "m",
  });
  await chat(
    agent,
    out,
    handlers,
    "write a",
    Readable.from(["y\n", "\n", "/mode auto\n", "/exit\n"]),
  );
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hi");
  expect(output).toContain("write_file(a.txt)");
  expect(output).toContain("+hi");
  expect(output).toContain("done");
  expect(output).toContain("Mode set to auto.");
});

it("prints failures and stops at end of input", async () => {
  const agent = await createCodingAgent({
    root,
    provider: createFakeProvider(() => Promise.reject(new Error("boom"))),
    approve: () => Promise.resolve("no"),
  });
  const out = printer();
  await chat(
    agent,
    out,
    commands(agent, { provider: "ollama", model: "m" }),
    "go",
    Readable.from([]),
  );
  expect(output).toMatch(/boom|failed/);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await printOnce(agent, "go", out)).toBe(1);
  expect(colorDiff("+a\n-b\n c")).toContain("a");
});

it("runs one prompt from the command line", async () => {
  vi.stubEnv("YADA_LLM_PROVIDER", "ollama");
  vi.stubEnv("YADA_LLM_MODEL", "m");
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          [
            {
              choices: [
                { index: 0, delta: { role: "assistant", content: "Hel" } },
              ],
            },
            {
              choices: [
                { index: 0, delta: { content: "lo" }, finish_reason: "stop" },
              ],
            },
          ]
            .map(
              (chunk) =>
                `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "m", ...chunk })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ),
  );
  vi.spyOn(process, "cwd").mockReturnValue(root);
  expect(await startCoding(["-p", "hi"])).toBe(0);
  expect(output).toContain("Hello");
  await expect(startCoding(["--bogus"])).rejects.toThrow("Usage: yada");
  await expect(startCoding(["--mode", "x"])).rejects.toThrow("Usage: yada");
  await expect(startCoding(["--resume", "nope"])).rejects.toThrow(
    "No session nope",
  );
  expect(await startCoding(["-c", "-p", "again"])).toBe(0);
});

it("opens the full-screen interface in a terminal", async () => {
  vi.stubEnv("YADA_LLM_PROVIDER", "ollama");
  vi.stubEnv("YADA_LLM_MODEL", "m");
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const tty = [process.stdout, process.stdin].map((stream) =>
    Object.getOwnPropertyDescriptor(stream, "isTTY"),
  );
  for (const stream of [process.stdout, process.stdin])
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  try {
    expect(await startCoding(["fix", "it"])).toBe(0);
  } finally {
    [process.stdout, process.stdin].forEach((stream, index) => {
      const descriptor = tty[index];
      if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
      else Reflect.deleteProperty(stream, "isTTY");
    });
  }
  expect(output).toContain("tui:fix it");
});

it("waits for lines typed later", async () => {
  const input = new PassThrough();
  const provider = createFakeProvider((_request, n) =>
    n === 1
      ? {
          content: "",
          toolCalls: [{ id: "c1", name: "bash", args: { command: "echo" } }],
          finishReason: "tool_calls",
        }
      : say("ok"),
  );
  const out = printer();
  const agent = await createCodingAgent({
    root,
    provider,
    approve: (request) => handlers.approve(request),
    onEvent: out.onEvent,
  });
  const handlers = commands(agent, { provider: "ollama", model: "m" });
  const done = chat(agent, out, handlers, undefined, input);
  await vi.waitFor(() => {
    expect(output).toContain("›");
  });
  input.write("/help\n");
  await vi.waitFor(() => {
    expect(output).toContain("/undo");
  });
  input.write("run it\n");
  await vi.waitFor(() => {
    expect(output).toContain("Allow bash?");
  });
  input.write("n\n");
  await vi.waitFor(() => {
    expect(output).toContain("ok");
  });
  input.end();
  await done;
});
