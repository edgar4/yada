import { execFile, spawn } from "node:child_process";
import { glob, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { z } from "zod";
import { writeTool } from "../core/action.js";
import type { Tool } from "../core/contracts.js";
import { readTool } from "../core/tool.js";

const maxOutput = 30_000;
const exclude = (name: string) => /(^|[/\\])(node_modules|\.git)$/.test(name);
const allow = () => Promise.resolve(true);

export function truncate(text: string, limit = maxOutput) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n[... ${String(text.length - limit)} characters omitted ...]\n${text.slice(-half)}`;
}

export function diff(path: string, before: string, after: string) {
  const lines = (text: string) =>
    text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const from = Math.max(0, start - 3);
  const context = (lines: string[], to: number) =>
    lines.slice(to, to + 3).map((line) => ` ${line}`);
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${String(from + 1)} +${String(from + 1)} @@`,
    ...a.slice(from, start).map((line) => ` ${line}`),
    ...a.slice(start, a.length - end).map((line) => `-${line}`),
    ...b.slice(start, b.length - end).map((line) => `+${line}`),
    ...context(a, a.length - end),
  ].join("\n");
}

async function readText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
) {
  return new Promise<{ output: string; code: number } | undefined>(
    (done, fail) => {
      execFile(
        command,
        args,
        { cwd, signal, maxBuffer: 16_000_000 },
        (error, stdout, stderr) => {
          if (error?.code === "ENOENT") done(undefined);
          else if (error && typeof error.code !== "number")
            fail(new Error(error.message, { cause: error }));
          else
            done({
              output: stdout + stderr,
              code: typeof error?.code === "number" ? error.code : 0,
            });
        },
      );
    },
  );
}

export function codingTools(options: { root: string }): Tool[] {
  const root = resolve(options.root);
  const real = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch {
      const parent = dirname(path);
      return parent === path ? path : join(await real(parent), basename(path));
    }
  };
  const locate = async (path: string) => {
    const target = resolve(root, path);
    const inside = relative(await real(root), await real(target));
    if (
      relative(root, target).startsWith("..") ||
      inside.startsWith("..") ||
      isAbsolute(inside)
    )
      throw new Error(`Path is outside the project: ${path}`);
    return target;
  };
  const show = (path: string) => relative(root, path) || ".";
  const editInput = z.strictObject({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().default(false),
  });
  const edited = async (args: z.output<typeof editInput>) => {
    const path = await locate(args.path);
    const before = await readText(path);
    if (before === undefined) throw new Error(`File not found: ${args.path}`);
    const count = before.split(args.old_string).length - 1;
    if (count === 0) throw new Error("old_string was not found in the file");
    if (count > 1 && !args.replace_all)
      throw new Error(
        `old_string matches ${String(count)} times; add surrounding context to make it unique or set replace_all`,
      );
    const after = args.replace_all
      ? before.replaceAll(args.old_string, () => args.new_string)
      : before.replace(args.old_string, () => args.new_string);
    return { path, before, after };
  };
  const writeInput = z.strictObject({
    path: z.string().min(1),
    content: z.string(),
  });
  const bashInput = z.strictObject({
    command: z.string().min(1),
    timeout_ms: z.number().int().positive().max(600_000).default(120_000),
  });
  return [
    readTool({
      name: "read_file",
      description:
        "Read a text file in the project. Returns numbered lines. Use offset (1-based line) and limit to read part of a large file.",
      input: z.strictObject({
        path: z.string().min(1),
        offset: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(5000).default(2000),
      }),
      authorize: allow,
      execute: async ({ path, offset, limit }) => {
        const text = await readText(await locate(path));
        if (text === undefined) throw new Error(`File not found: ${path}`);
        const lines = text.split("\n");
        const shown = lines
          .slice(offset - 1, offset - 1 + limit)
          .map(
            (line, index) =>
              `${String(offset + index)}\t${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`,
          )
          .join("\n");
        const rest = lines.length - (offset - 1 + limit);
        return truncate(
          rest > 0
            ? `${shown}\n[${String(rest)} more lines; continue with offset ${String(offset + limit)}]`
            : shown,
        );
      },
    }),
    readTool({
      name: "list_files",
      description:
        "List project files matching a glob pattern such as **/*.ts. Skips node_modules and .git.",
      input: z.strictObject({
        pattern: z.string().min(1).default("**/*"),
        path: z.string().default("."),
      }),
      authorize: allow,
      execute: async ({ pattern, path }) => {
        const cwd = await locate(path);
        const files: string[] = [];
        for await (const entry of glob(pattern, {
          cwd,
          exclude,
        })) {
          files.push(show(resolve(cwd, entry)));
          if (files.length > 1000) break;
        }
        return files.length > 1000
          ? `${files.slice(0, 1000).join("\n")}\n[more than 1000 files; narrow the pattern]`
          : files.sort().join("\n") || "No files found";
      },
    }),
    readTool({
      name: "grep",
      description:
        "Search file contents with a regular expression. Returns matching lines as path:line:text. Respects .gitignore when ripgrep is installed.",
      input: z.strictObject({
        pattern: z.string().min(1),
        path: z.string().default("."),
        glob: z.string().optional(),
        ignore_case: z.boolean().default(false),
      }),
      authorize: allow,
      execute: async (args, _identity, signal) => {
        const cwd = await locate(args.path);
        const found = await run(
          "rg",
          [
            "--line-number",
            "--no-heading",
            "--color=never",
            "--max-columns=500",
            ...(args.ignore_case ? ["-i"] : []),
            ...(args.glob ? ["--glob", args.glob] : []),
            "-e",
            args.pattern,
            ".",
          ],
          cwd,
          signal,
        );
        if (found?.code === 1) return "No matches";
        if (found && found.code !== 0) throw new Error(found.output);
        if (found)
          return truncate(
            found.output
              .split("\n")
              .map((line) => line.replace(/^\.\//, ""))
              .join("\n"),
          );
        const regex = new RegExp(args.pattern, args.ignore_case ? "i" : "");
        const matches: string[] = [];
        for await (const entry of glob(args.glob ?? "**/*", {
          cwd,
          exclude,
        })) {
          const text = await readFile(resolve(cwd, entry), "utf8").catch(
            () => "",
          );
          if (text.includes("\0")) continue;
          text.split("\n").forEach((line, index) => {
            if (regex.test(line))
              matches.push(
                `${show(resolve(cwd, entry))}:${String(index + 1)}:${line.slice(0, 500)}`,
              );
          });
        }
        return matches.length ? truncate(matches.join("\n")) : "No matches";
      },
    }),
    writeTool({
      name: "edit_file",
      description:
        "Replace an exact string in a file. old_string must match the file exactly, including whitespace, and be unique unless replace_all is set. Read the file first.",
      version: "1",
      input: editInput,
      authorize: allow,
      prepare: async (args) => {
        const { path, before, after } = await edited(args);
        return { preview: diff(show(path), before, after), version: "1" };
      },
      execute: async (args) => {
        const { path, after } = await edited(args);
        await writeFile(path, after);
        return `Edited ${show(path)}`;
      },
    }),
    writeTool({
      name: "write_file",
      description:
        "Create or overwrite a file with the given content. Prefer edit_file for changes to existing files.",
      version: "1",
      input: writeInput,
      authorize: allow,
      prepare: async ({ path, content }) => {
        const target = await locate(path);
        return {
          preview: diff(show(target), (await readText(target)) ?? "", content),
          version: "1",
        };
      },
      execute: async ({ path, content }) => {
        const target = await locate(path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        return `Wrote ${show(target)}`;
      },
    }),
    writeTool({
      name: "bash",
      description:
        "Run a shell command in the project directory, for example to run tests, builds or git. Returns combined output and the exit code. Avoid interactive commands.",
      version: "1",
      input: bashInput,
      authorize: allow,
      prepare: ({ command }) =>
        Promise.resolve({ preview: `$ ${command}`, version: "1" }),
      execute: ({ command, timeout_ms }, { signal }) =>
        new Promise((done) => {
          const child = spawn("bash", ["-c", command], {
            cwd: root,
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeout_ms)]),
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          const collect = (chunk: Buffer) => {
            output += chunk.toString();
            if (output.length > 4 * maxOutput)
              output = truncate(output, 2 * maxOutput);
          };
          child.stdout.on("data", collect);
          child.stderr.on("data", collect);
          child.on("error", (error) => {
            done(
              `${truncate(output)}\n[${error.name === "AbortError" ? "timed out or cancelled" : error.message}]`,
            );
          });
          child.on("close", (code) => {
            done(`${truncate(output)}\n[exit code ${String(code)}]`);
          });
        }),
    }),
  ];
}
