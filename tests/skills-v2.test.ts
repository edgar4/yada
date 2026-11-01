import { contentText } from "../src/core/content.js";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills, applyToolPolicy } from "../src/index.js";
import type { SkillScriptRunner } from "../src/index.js";
import { parseSkill } from "../src/skills/metadata.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const identity = { actorId: "actor", tenantId: "tenant" };
const authorize = () => Promise.resolve(true);
const header = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nBody for ${name}`;
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "yada-skills2-"));
  roots.push(dir);
  return dir;
}
async function skill(
  base: string,
  name: string,
  files: Record<string, string>,
  extra = "",
) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), header(name, extra));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}
const signal = () => new AbortController().signal;

it("reads a 60 KiB file in chunks under the tool output cap", async () => {
  const base = await root();
  const text = Array.from({ length: 6000 }, (_, i) => String(i % 10).repeat(9))
    .join("\n")
    .slice(0, 61_440);
  await skill(base, "big", { "references/big.md": text });
  const catalog = await loadSkills({ directories: [base], authorize });
  const tool = catalog.tools[0];
  if (!tool) throw new Error("tool");
  let offset = 0;
  let joined = "";
  let calls = 0;
  for (;;) {
    const out = contentText(
      await tool.execute(
        { name: "big", path: "references/big.md", offset },
        identity,
        signal(),
      ),
    );
    expect(out.length).toBeLessThan(32_000);
    const parsed = JSON.parse(out) as {
      content: string;
      nextOffset?: number;
      total: number;
    };
    joined += parsed.content;
    calls++;
    expect(parsed.total).toBe(text.length);
    if (parsed.nextOffset === undefined) break;
    offset = parsed.nextOffset;
  }
  expect(joined).toBe(text);
  expect(calls).toBeGreaterThan(3);
  const small = JSON.parse(
    contentText(
      await tool.execute(
        { name: "big", path: "references/big.md", limit: 10 },
        identity,
        signal(),
      ),
    ),
  ) as { content: string; nextOffset: number };
  expect(small).toMatchObject({ content: text.slice(0, 10), nextOffset: 10 });
});

it("shrinks chunks of escape-heavy content and never splits surrogates", async () => {
  const base = await root();
  const heavy = "\u0001".repeat(16_000) + "😀".repeat(100);
  await skill(base, "heavy", { "a.txt": heavy });
  const catalog = await loadSkills({ directories: [base], authorize });
  const tool = catalog.tools[0];
  if (!tool) throw new Error("tool");
  let offset = 0;
  let joined = "";
  for (;;) {
    const out = contentText(
      await tool.execute(
        { name: "heavy", path: "a.txt", offset },
        identity,
        signal(),
      ),
    );
    expect(out.length).toBeLessThan(32_000);
    const parsed = JSON.parse(out) as { content: string; nextOffset?: number };
    joined += parsed.content;
    if (parsed.nextOffset === undefined) break;
    offset = parsed.nextOffset;
  }
  expect(joined).toBe(heavy);
});

it.each([
  ["Bash(git add *) Read, Grep", ["Bash(git add *)", "Read", "Grep"]],
  [
    ["Read", "Edit"],
    ["Read", "Edit"],
  ],
  [undefined, []],
])("parses allowed-tools %#", (value, expected) => {
  const line =
    value === undefined ? "" : `allowed-tools: ${JSON.stringify(value)}\n`;
  const parsed = parseSkill(header("a", line), "a");
  expect(parsed.allowedTools).toEqual(expected);
  expect(parsed.warnings).toEqual([]);
});

it("rejects invalid allowed-tools and exposes them on the catalog", async () => {
  expect(() => parseSkill(header("a", "allowed-tools: 3\n"), "a")).toThrow();
  const base = await root();
  await skill(base, "a", {}, "allowed-tools: Read Grep\n");
  const catalog = await loadSkills({ directories: [base], authorize });
  expect(catalog.skills).toEqual([
    { name: "a", description: "Does a", allowedTools: ["Read", "Grep"] },
  ]);
  expect(catalog.warnings).toEqual([]);
});

it("reloads atomically with a stable tools array", async () => {
  const base = await root();
  const dir = await skill(base, "a", { "r.md": "old" });
  const catalog = await loadSkills({ directories: [base], authorize });
  const tools = catalog.tools;
  const tool = tools[0];
  if (!tool) throw new Error("tool");
  const before = catalog.system;
  await writeFile(join(dir, "r.md"), "new");
  const inFlight = tool.execute(
    { name: "a", path: "r.md" },
    identity,
    signal(),
  );
  await catalog.reload();
  expect(await inFlight).toContain("old");
  expect(
    await tool.execute({ name: "a", path: "r.md" }, identity, signal()),
  ).toContain("new");
  expect(catalog.system).not.toBe(before);
  expect(catalog.tools).toBe(tools);

  await writeFile(join(dir, "bad.txt"), Buffer.from([0xff]));
  const stable = catalog.system;
  await expect(catalog.reload()).rejects.toThrow();
  expect(catalog.system).toBe(stable);
  expect(
    await tool.execute({ name: "a", path: "r.md" }, identity, signal()),
  ).toContain("new");
  await rm(join(dir, "bad.txt"));

  await skill(base, "b", {});
  await catalog.reload();
  expect(catalog.skills.map((s) => s.name)).toEqual(["a", "b"]);
  await rm(base, { recursive: true });
  await catalog.reload();
  expect([catalog.system, catalog.tools.length]).toEqual(["", 0]);
  expect(catalog.tools).toBe(tools);
  await mkdir(base);
  await skill(base, "c", {});
  await catalog.reload();
  expect(catalog.tools).toBe(tools);
  expect(catalog.tools).toHaveLength(1);
});

it("registers the script tool only with a runner and always asks", async () => {
  const base = await root();
  await skill(base, "s", {
    "scripts/go.py": "print(1)",
    "references/x.py": "x",
  });
  const plain = await loadSkills({ directories: [base], authorize });
  expect(plain.tools.map((t) => t.spec.name)).toEqual(["yada_read_skill"]);

  const calls: Parameters<SkillScriptRunner>[0][] = [];
  const catalog = await loadSkills({
    directories: [base],
    authorize,
    runner: (input) => {
      calls.push(input);
      return Promise.resolve({
        stdout: "o".repeat(20_000),
        stderr: "e",
        exitCode: 3,
      });
    },
  });
  expect(catalog.tools.map((t) => t.spec.name)).toEqual([
    "yada_read_skill",
    "yada_run_skill_script",
  ]);
  const tool = catalog.tools[1];
  if (!tool || tool.effect !== "write") throw new Error("expected write tool");
  expect(
    applyToolPolicy(catalog.tools, { yada_run_skill_script: "allow" }).find(
      (t) => t.spec.name === "yada_run_skill_script",
    )?.effect,
  ).toBe("write");
  const prepared = await tool.prepare(
    { name: "s", path: "scripts/go.py", args: ["a"] },
    identity,
    signal(),
  );
  expect(prepared.preview).toContain("scripts/go.py");

  const exec = (args: unknown) =>
    tool.execute(args, {
      identity,
      signal: signal(),
    } as never);
  const out = JSON.parse(
    await exec({ name: "s", path: "./scripts/go.py", args: ["a"] }),
  ) as { stdout: string; stderr: string; exitCode: number };
  expect(out).toMatchObject({ exitCode: 3, stderr: "e" });
  expect(out.stdout.length).toBeLessThan(13_000);
  expect(calls[0]).toMatchObject({
    skill: { name: "s", directory: join(base, "s") },
    path: "scripts/go.py",
    args: ["a"],
  });

  for (const path of [
    "references/x.py",
    "SKILL.md",
    "scripts/../references/x.py",
    "../s/scripts/go.py",
    "/etc/passwd",
    "scripts/missing.sh",
  ]) {
    await expect(exec({ name: "s", path })).rejects.toThrow(
      "Unknown skill script",
    );
  }
  expect(calls).toHaveLength(1);
});

it("rejects script paths that become symlinks after loading", async () => {
  const base = await root();
  const dir = await skill(base, "s", { "scripts/go.py": "print(1)" });
  let ran = 0;
  const catalog = await loadSkills({
    directories: [base],
    authorize,
    runner: () => {
      ran++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    },
  });
  const tool = catalog.tools[1];
  if (!tool || tool.effect !== "write") throw new Error("expected write tool");
  await rm(join(dir, "scripts/go.py"));
  await writeFile(join(base, "outside.py"), "x");
  await symlink(join(base, "outside.py"), join(dir, "scripts/go.py"));
  await expect(
    tool.execute({ name: "s", path: "scripts/go.py" }, {
      identity,
      signal: signal(),
    } as never),
  ).rejects.toThrow("Unknown skill script");
  expect(ran).toBe(0);
});

it("loads Codex/ChatGPT layouts with agents/openai.yaml and assets", async () => {
  const base = await root();
  await skill(base, "codex", {
    "agents/openai.yaml":
      'interface:\n  display_name: "Codex"\n  icon_small: "./assets/small-logo.svg"\n  brand_color: "#3B82F6"\npolicy:\n  allow_implicit_invocation: false\ndependencies:\n  tools:\n    - type: "mcp"\n      value: "docs"\n      transport: "streamable_http"\n      url: "https://example.com/mcp"\n',
    "assets/small-logo.svg": "<svg/>",
    "scripts/run.sh": "echo hi",
  });
  await writeFile(
    join(base, "codex/assets/large-logo.png"),
    Buffer.from([0xff, 0x00]),
  );
  const catalog = await loadSkills({ directories: [base], authorize });
  expect(catalog.warnings).toEqual([]);
  const tool = catalog.tools[0];
  if (!tool) throw new Error("tool");
  const out = JSON.parse(
    contentText(await tool.execute({ name: "codex" }, identity, signal())),
  ) as { resources: string[] };
  expect(out.resources).toEqual([
    "agents/openai.yaml",
    "assets/small-logo.svg",
    "scripts/run.sh",
  ]);
});

it("loads Claude layouts with extra frontmatter and no explicit name", async () => {
  const base = await root();
  await skill(
    base,
    "claude",
    { "reference.md": "ref", "scripts/helper.py": "pass" },
    "argument-hint: '[issue]'\ndisable-model-invocation: true\nallowed-tools:\n  - Bash(gh *)\n  - Read\ncontext: fork\nhooks:\n  PreToolUse: []\n",
  );
  const dir = join(base, "implicit");
  await mkdir(dir);
  await writeFile(
    join(dir, "SKILL.md"),
    "---\ndescription: Name defaults to folder\n---\nBody",
  );
  const catalog = await loadSkills({ directories: [base], authorize });
  expect(catalog.skills.map((s) => s.name)).toEqual(["claude", "implicit"]);
  expect(catalog.skills[0]?.allowedTools).toEqual(["Bash(gh *)", "Read"]);
  expect(catalog.warnings).toHaveLength(4);
});
