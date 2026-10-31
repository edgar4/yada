import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills, createFakeProvider, run } from "../src/index.js";
import { parseSkill } from "../src/skills/metadata.js";
import { starterConfigFromEnv } from "../examples/starter/config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const identity = { actorId: "actor", tenantId: "tenant" };
const authorize = () => Promise.resolve(true);
const source =
  "---\nname: support\ndescription: Help answer support questions\n---\nFollow references/policy.md. Ask for the order number first.";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yada-skills-"));
  roots.push(root);
  const directory = join(root, "support");
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(join(directory, "SKILL.md"), source);
  await writeFile(
    join(directory, "references/policy.md"),
    "Never disclose other customers' orders.",
  );
  return {
    root,
    directory,
    load: () => loadSkills({ directories: [root], authorize }),
  };
}

it("discovers metadata and loads instructions and references only on request", async () => {
  const f = await fixture();
  const catalog = await f.load();
  expect(catalog.system).toContain("Help answer support questions");
  expect(catalog.system).not.toContain("order number");
  const tool = catalog.tools[0];
  if (!tool) throw new Error("Missing skill tool");
  expect(await tool.authorize(identity)).toBe(true);
  const read = (args: unknown) =>
    tool.execute(args, identity, new AbortController().signal);
  expect(JSON.parse(await read({ name: "support" }))).toMatchObject({
    content: source,
    resources: ["references/policy.md"],
  });
  expect(
    await read({ name: "support", path: "./references/policy.md" }),
  ).toContain("Never disclose");
  for (const path of [
    "../support/SKILL.md",
    "/etc/passwd",
    "references/../../secret",
    "missing.md",
  ])
    await expect(read({ name: "support", path })).rejects.toThrow(
      "Unknown skill or resource",
    );
  await expect(read({ name: "unknown" })).rejects.toThrow(
    "Unknown skill or resource",
  );
  await expect(read({ name: "" })).rejects.toThrow();
  await expect(
    tool.execute({ name: "support" }, identity, AbortSignal.abort()),
  ).rejects.toThrow();
  await writeFile(join(f.directory, "references/policy.md"), "Changed policy");
  expect(
    await read({ name: "support", path: "references/policy.md" }),
  ).toContain("Never disclose");
  expect((await f.load()).system).not.toEqual(catalog.system);
});

it("uses skill tools through the existing provider loop and enforces host authorization", async () => {
  const f = await fixture();
  const catalog = await f.load();
  const provider = createFakeProvider((request) =>
    request.messages.some((turn) => turn.role === "tool")
      ? {
          content: "What is your order number?",
          toolCalls: [],
          finishReason: "stop",
        }
      : {
          content: "",
          toolCalls: [
            { id: "skill", name: "yada_read_skill", args: { name: "support" } },
          ],
          finishReason: "tool_calls",
        },
  );
  const options = {
    ...catalog,
    provider,
    identity,
    input: "Help with my order",
    signal: new AbortController().signal,
  };
  await expect(run(options)).resolves.toEqual({
    status: "completed",
    text: "What is your order number?",
  });
  const denied = await loadSkills({
    directories: [f.root],
    authorize: () => Promise.resolve(false),
  });
  await expect(run({ ...options, ...denied })).resolves.toEqual({
    status: "failed",
    code: "tool_denied",
  });
});

it.each([
  "skills",
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
])(
  "loads unchanged standard skills from %s including category folders",
  async (location) => {
    const f = await fixture();
    const target = join(f.root, location, "category", "support");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), source);
    const catalog = await loadSkills({
      directories: [join(f.root, location)],
      authorize,
    });
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.system).toContain("support");
    expect(
      (await loadSkills({ directories: [target, target], authorize })).system,
    ).toBe(catalog.system);
  },
);

it("supports multiline metadata and reports vendor extensions without granting capabilities", () => {
  const parsed = parseSkill(
    "---\r\nname: support\r\ndescription: >-\r\n  Answer support\r\n  questions\r\ncompatibility: Needs order tools\r\nmetadata:\r\n  author: team\r\nallowed-tools: Bash\r\ncontext: fork\r\n---\r\nInstructions",
    "support",
  );
  expect(parsed).toMatchObject({
    description: "Answer support questions",
    compatibility: "Needs order tools",
  });
  expect(parsed.warnings).toHaveLength(2);
});

it.each([
  "No metadata",
  "---\nname: support\n---\nbody",
  "---\nname: other\ndescription: Help\n---\nbody",
  "---\nname: support\ndescription: Help\ndescription: Duplicate\n---\nbody",
  "---\nname: support\ndescription: [invalid\n---\nbody",
  "---\nname: support\ndescription: !custom Help\n---\nbody",
  "---\nname: support\ndescription: Help\n---\n",
  "---\nname: support\ndescription: &a Help\nlicense: *a\n---\nbody",
])("rejects malformed or ambiguous metadata %#", (text) => {
  expect(() => parseSkill(text, "support")).toThrow();
});

it("ignores absent roots and rejects duplicate skill names", async () => {
  const f = await fixture();
  expect(
    await loadSkills({ directories: [join(f.root, "absent")], authorize }),
  ).toEqual({ system: "", tools: [], warnings: [] });
  await expect(
    loadSkills({ directories: [f.root, f.directory], authorize }),
  ).rejects.toThrow("Duplicate skill");
  await expect(
    loadSkills({ directories: [join(f.directory, "SKILL.md")], authorize }),
  ).rejects.toThrow("real directory");
});

it.each(["root", "skill", "resource"])("rejects %s symlinks", async (level) => {
  const f = await fixture();
  const link = join(f.root, "linked");
  if (level === "root") {
    await symlink(f.directory, link);
    await expect(
      loadSkills({ directories: [link], authorize }),
    ).rejects.toThrow("real directory");
  } else {
    await symlink(
      f.directory,
      level === "skill" ? link : join(f.directory, "references/link"),
    );
    await expect(f.load()).rejects.toThrow("symlinks");
  }
});

it("bounds text and ignores hidden files and binary assets", async () => {
  const f = await fixture();
  await mkdir(join(f.directory, ".private"));
  await writeFile(join(f.directory, ".private/secret.txt"), "secret");
  await writeFile(join(f.directory, "image.png"), Buffer.from([0xff]));
  let catalog = await f.load();
  const tool = catalog.tools[0];
  if (!tool) throw new Error("Missing skill tool");
  expect(
    await tool.execute(
      { name: "support" },
      identity,
      AbortSignal.timeout(1000),
    ),
  ).not.toContain("secret");
  await writeFile(join(f.directory, "large.txt"), "a".repeat(65_537));
  await expect(f.load()).rejects.toThrow("64 KiB");
  await writeFile(join(f.directory, "large.txt"), Buffer.from([0xff]));
  await expect(f.load()).rejects.toThrow();
  await rm(join(f.directory, "large.txt"));
  catalog = await f.load();
  expect(catalog.tools).toHaveLength(1);
});

it("limits directory depth and file counts", async () => {
  const f = await fixture();
  await mkdir(join(f.directory, ...Array<string>(10).fill("nested")), {
    recursive: true,
  });
  await expect(f.load()).rejects.toThrow("nesting");
  await rm(join(f.directory, "nested"), { recursive: true });
  await Promise.all(
    Array.from({ length: 257 }, (_, index) =>
      writeFile(join(f.directory, `${String(index)}.txt`), ""),
    ),
  );
  await expect(f.load()).rejects.toThrow("entries");
});

it("defaults to project-local discovery with a single directory override", () => {
  const env = {
    YADA_STORAGE_KEY: "ab".repeat(32),
    YADA_LLM_PROVIDER: "gemini",
    YADA_LLM_API_KEY: "test",
  };
  expect(starterConfigFromEnv(env).skillDirectories).toEqual([
    "skills",
    ".agents/skills",
    ".claude/skills",
    ".cursor/skills",
    ".codex/skills",
  ]);
  expect(
    starterConfigFromEnv({ ...env, YADA_SKILLS_DIR: "/project/skills" })
      .skillDirectories,
  ).toEqual(["/project/skills"]);
});

it("rejects empty instructions and excessive discovery trees", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "SKILL.md"), "");
  await expect(f.load()).rejects.toThrow("frontmatter");
  await rm(f.directory, { recursive: true });
  await mkdir(join(f.root, ...Array<string>(10).fill("category")), {
    recursive: true,
  });
  await expect(f.load()).rejects.toThrow("discovery limit");
});

it("bounds skill counts and aggregate text memory", async () => {
  const f = await fixture();
  for (let index = 0; index < 50; index++) {
    const name = `skill-${String(index)}`;
    await mkdir(join(f.root, name));
    await writeFile(
      join(f.root, name, "SKILL.md"),
      source.replace("name: support", `name: ${name}`),
    );
  }
  await expect(f.load()).rejects.toThrow("At most 50");
  await rm(f.root, { recursive: true });
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, "SKILL.md"), source);
  for (let index = 0; index < 33; index++)
    await writeFile(
      join(f.directory, `${String(index)}.txt`),
      "a".repeat(65_536),
    );
  await expect(f.load()).rejects.toThrow("text size limit");
  await rm(f.directory, { recursive: true });
  for (let index = 0; index < 5; index++) {
    const name = `skill-${String(index)}`;
    const directory = join(f.root, name);
    await mkdir(directory);
    await writeFile(
      join(directory, "SKILL.md"),
      source.replace("name: support", `name: ${name}`),
    );
    for (let file = 0; file < 31; file++)
      await writeFile(
        join(directory, `${String(file)}.txt`),
        "a".repeat(60_000),
      );
  }
  await expect(f.load()).rejects.toThrow("catalog exceeds");
});
