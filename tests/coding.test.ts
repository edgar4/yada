import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  codingSystem,
  codingTools,
  createCodingAgent,
  createFakeProvider,
  listSessions,
} from "../src/index.js";
import type {
  ProviderResult,
  ReadTool,
  Tool,
  WriteTool,
} from "../src/index.js";
import { settled } from "../src/coding/agent.js";
import { diff, truncate } from "../src/coding/tools.js";
import { commands } from "../src/cli/coding.js";
import { callSummary, resultSummary, failureText } from "../src/cli/format.js";

const identity = { actorId: "a", tenantId: "t" };
const signal = new AbortController().signal;
const say = (content: string): ProviderResult => ({
  content,
  toolCalls: [],
  finishReason: "stop",
});
const call = (name: string, args: unknown, id = "c1"): ProviderResult => ({
  content: "",
  toolCalls: [{ id, name, args }],
  finishReason: "tool_calls",
});
let root: string;
let home: string;
let tools: Map<string, Tool>;
const read = (name: string, args: unknown) =>
  (tools.get(name) as ReadTool).execute(args, identity, signal);
const write = async (name: string, args: unknown) => {
  const tool = tools.get(name) as WriteTool;
  const { preview, version } = await tool.prepare(args, identity, signal);
  return {
    preview,
    result: await tool.execute(args, {
      identity,
      signal,
      operationId: "op",
      version,
    }),
  };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "yada-code-"));
  home = await mkdtemp(join(tmpdir(), "yada-home-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
  await writeFile(join(root, "node_modules", "x.ts"), "two\n");
  tools = new Map(codingTools({ root }).map((tool) => [tool.spec.name, tool]));
});

describe("coding tools", () => {
  it("reads files with line numbers and ranges", async () => {
    expect(await read("read_file", { path: "src/a.ts" })).toBe(
      "1\tone\n2\ttwo\n3\tthree\n4\t",
    );
    expect(
      await read("read_file", { path: "src/a.ts", offset: 2, limit: 1 }),
    ).toBe("2\ttwo\n[2 more lines; continue with offset 3]");
    await expect(read("read_file", { path: "missing" })).rejects.toThrow(
      "File not found",
    );
  });

  it("keeps paths inside the project", async () => {
    await expect(read("read_file", { path: "../etc" })).rejects.toThrow(
      "outside the project",
    );
    await symlink(tmpdir(), join(root, "escape"));
    await expect(read("read_file", { path: "escape/x" })).rejects.toThrow(
      "outside the project",
    );
  });

  it("lists and searches files without node_modules", async () => {
    expect(await read("list_files", { pattern: "**/*.ts" })).toBe("src/a.ts");
    expect(await read("list_files", { pattern: "*.md" })).toBe(
      "No files found",
    );
    expect(await read("grep", { pattern: "TWO", ignore_case: true })).toContain(
      "src/a.ts:2:two",
    );
    expect(await read("grep", { pattern: "nothing" })).toBe("No matches");
  });

  it.skipIf(process.platform === "win32")(
    "searches with ripgrep when it is installed",
    async () => {
      const bin = await mkdtemp(join(tmpdir(), "yada-rg-"));
      await writeFile(
        join(bin, "rg"),
        '#!/bin/sh\ncase "$*" in *none*) exit 1;; *bad*) echo broken; exit 2;; esac\necho ./src/a.ts:2:two\n',
        { mode: 0o700 },
      );
      const path = process.env["PATH"];
      process.env["PATH"] = `${bin}:${path ?? ""}`;
      try {
        expect(
          await read("grep", {
            pattern: "two",
            glob: "*.ts",
            ignore_case: true,
          }),
        ).toBe("src/a.ts:2:two\n");
        expect(await read("grep", { pattern: "none" })).toBe("No matches");
        await expect(read("grep", { pattern: "bad" })).rejects.toThrow(
          "broken",
        );
      } finally {
        process.env["PATH"] = path;
      }
    },
  );

  it("edits files exactly once with a diff preview", async () => {
    const { preview, result } = await write("edit_file", {
      path: "src/a.ts",
      old_string: "two",
      new_string: "2",
    });
    expect(preview).toContain("-two\n+2");
    expect(result).toBe("Edited src/a.ts");
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(
      "one\n2\nthree\n",
    );
    await expect(
      write("edit_file", {
        path: "src/a.ts",
        old_string: "zz",
        new_string: "",
      }),
    ).rejects.toThrow("not found");
    await writeFile(join(root, "b.txt"), "x x");
    await expect(
      write("edit_file", { path: "b.txt", old_string: "x", new_string: "y" }),
    ).rejects.toThrow("matches 2 times");
    await write("edit_file", {
      path: "b.txt",
      old_string: "x",
      new_string: "$&",
      replace_all: true,
    });
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("$& $&");
  });

  it("writes new files and runs commands", async () => {
    const { preview } = await write("write_file", {
      path: "new/c.ts",
      content: "hi",
    });
    expect(preview).toContain("+hi");
    expect(await readFile(join(root, "new", "c.ts"), "utf8")).toBe("hi");
    const { preview: command, result } = await write("bash", {
      command: "echo out; echo err >&2; exit 3",
    });
    expect(command).toBe("$ echo out; echo err >&2; exit 3");
    expect(result).toContain("out\nerr\n");
    expect(result).toContain("[exit code 3]");
    expect(
      (await write("bash", { command: "sleep 5", timeout_ms: 50 })).result,
    ).toContain("timed out or cancelled");
  });

  it("truncates long output and diffs whole files", () => {
    expect(truncate("abcdefghij", 4)).toBe(
      "ab\n[... 6 characters omitted ...]\nij",
    );
    expect(diff("f", "", "a\nb")).toBe("--- f\n+++ f\n@@ -1 +1 @@\n+a\n+b");
  });
});

describe("coding agent", () => {
  it("builds a system prompt from project instructions and git", async () => {
    await writeFile(join(root, "AGENTS.md"), "Use tabs.");
    const system = await codingSystem(root);
    expect(system).toContain("Use tabs.");
    expect(system).toContain("Not a git repository.");
  });

  it("asks before writes, remembers always, saves and undoes", async () => {
    const provider = createFakeProvider((_request, n) =>
      n === 1
        ? call("write_file", { path: "x.txt", content: "1" })
        : n === 2
          ? call(
              "edit_file",
              { path: "x.txt", old_string: "1", new_string: "2" },
              "c2",
            )
          : say("done"),
    );
    const asked: string[] = [];
    const events: string[] = [];
    const agent = await createCodingAgent({
      root,
      home,
      provider,
      approve: ({ tool }) => {
        asked.push(tool);
        return Promise.resolve(tool === "write_file" ? "always" : "yes");
      },
      onEvent: (event) => events.push(event.type),
    });
    expect(await agent.send("make x", signal)).toMatchObject({
      status: "completed",
    });
    expect(asked).toEqual(["write_file", "edit_file"]);
    expect(events).toContain("tool_finished");
    expect(await readFile(join(root, "x.txt"), "utf8")).toBe("2");
    const [saved] = await listSessions(root, home);
    expect(saved?.title).toBe("make x");
    expect(saved?.messages.at(-1)).toMatchObject({ content: "done" });
    expect(await agent.undo()).toEqual(["x.txt"]);
    await expect(readFile(join(root, "x.txt"))).rejects.toThrow();
    expect(await agent.undo()).toEqual([]);
    await agent.send("again", signal);
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain(
      "reverted your file changes",
    );
  });

  it("returns declines and failures to the model and respects modes", async () => {
    const provider = createFakeProvider((request, n) =>
      n % 2 === 1
        ? call("bash", { command: "echo hi" }, `c${String(n)}`)
        : say(JSON.stringify(request.messages.at(-1))),
    );
    const agent = await createCodingAgent({
      root,
      home,
      provider,
      approve: () => Promise.resolve("no"),
    });
    expect(await agent.send("run", signal)).toMatchObject({
      text: expect.stringContaining("declined") as string,
    });
    agent.mode = "auto";
    expect(await agent.send("run", signal)).toMatchObject({
      text: expect.stringContaining("exit code 0") as string,
    });
    agent.mode = "read-only";
    expect(await agent.send("run", signal)).toMatchObject({
      text: expect.stringContaining("not available") as string,
    });
    agent.mode = "auto-edit";
    const failing = createFakeProvider((request, n) =>
      n === 1
        ? call("edit_file", { path: "nope", old_string: "a", new_string: "b" })
        : say(JSON.stringify(request.messages.at(-1))),
    );
    agent.provider = failing;
    expect(await agent.send("edit", signal)).toMatchObject({
      text: expect.stringContaining("tool_failed") as string,
    });
    expect(agent.provider).toBe(failing);
  });

  it("drops unanswered tool calls after a cancelled turn", async () => {
    const controller = new AbortController();
    const agent = await createCodingAgent({
      root,
      home,
      provider: createFakeProvider(() => call("bash", { command: "echo" })),
      approve: () => {
        controller.abort();
        return Promise.resolve("no");
      },
    });
    expect(await agent.send("go", controller.signal)).toEqual({
      status: "cancelled",
    });
    expect(
      agent.session.messages.every((turn) => turn.role !== "assistant"),
    ).toBe(true);
    expect(
      settled([
        { role: "user", content: "a" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "x", name: "t", args: {} }],
        },
      ]),
    ).toEqual([{ role: "user", content: "a" }]);
  });
});

describe("terminal commands", () => {
  it("handles slash commands", async () => {
    const agent = await createCodingAgent({
      root,
      home,
      provider: createFakeProvider(() => say("ok")),
      approve: () => Promise.resolve("no"),
    });
    const config = { provider: "anthropic", apiKey: "k", model: "m" } as const;
    const handle = commands(agent, config);
    expect(await handle.approve({ tool: "t", preview: "" })).toBe("no");
    expect(await handle.run("/exit", "h")).toBeNull();
    expect(await handle.run("/help", "h")).toBe("h");
    expect(await handle.run("/resume", "h")).toBe(
      "No sessions for this directory.",
    );
    await agent.send("first", signal);
    expect(await handle.run("/resume", "h")).toMatch(/^1\. first · /);
    const id = agent.session.id;
    expect(await handle.run("/clear", "h")).toBe("Started a new session.");
    expect(agent.session.id).not.toBe(id);
    expect(await handle.run("/resume 1", "h")).toBe(
      'Resumed "first" (2 messages).',
    );
    expect(agent.session.id).toBe(id);
    expect(await handle.run("/mode auto", "h")).toBe("Mode set to auto.");
    expect(await handle.run("/mode x", "h")).toContain("Mode is auto");
    expect(await handle.run("/model", "h")).toBe("Usage: /model <name>");
    expect(await handle.run("/model other", "h")).toBe("Model set to other.");
    expect(agent.provider.name).toBe("anthropic");
    expect(await handle.run("/undo", "h")).toBe("No file changes to undo.");
    expect(await handle.run("/nope", "h")).toContain("Unknown command");
  });

  it("summarizes tool calls and results", () => {
    expect(
      callSummary({ id: "1", name: "bash", args: { command: "ls" } }),
    ).toBe("bash(ls)");
    expect(
      callSummary({ id: "1", name: "t", args: { a: "x".repeat(90) } }),
    ).toHaveLength(83);
    expect(resultSummary("a\nb", false)).toBe("2 lines");
    expect(resultSummary('{"error":"x","message":"bad"}', false)).toBe("bad");
    expect(failureText("cancelled")).toBe("Stopped.");
    expect(failureText("limit")).toBe("The run failed: limit.");
  });
});
