---
layout: doc
title: "Skills"
description: "Reuse SKILL.md instructions and resources from Claude, Cursor, Codex and other Agent Skills tools with any Yada model provider."
---

# Skills

Skills give Yada reusable instructions for a task. They use the open [Agent Skills format](https://agentskills.io/specification): a folder containing `SKILL.md`, with optional references, scripts and assets. Yada exposes skill descriptions to the model and supplies the full instructions and bundled text resources when it calls `yada_read_skill`.

Skills work with any Yada provider that supports tool calling. A skill teaches a workflow; your configured tools and MCP servers provide its capabilities.

## Add a skill

Put the skill folder in your project's `skills/` directory and restart the starter:

```text
skills/
  customer-support/
    SKILL.md
    references/
      policy.md
```

```markdown
---
name: customer-support
description: Answer customer questions about orders and returns.
---

Ask for the order number before looking up an order.
Read references/policy.md before explaining the return policy.
Use the host's order lookup tool; do not invent order details.
```

No configuration is required. The starter also discovers `.agents/skills/`, `.claude/skills/`, `.cursor/skills/` and `.codex/skills/` under its working directory, including category folders. It does not search your home directory or other projects. Set `YADA_SKILLS_DIR=/path/to/skills` to replace these defaults with one explicit directory. That directory may contain several skills or be a single skill folder.

Ask for a task matching a skill's description, or mention its name in your message. Selection is performed by the model. The starter snapshots files on startup; restart to pick up changes (SDK hosts can call `reload()`, see below). Finish active runs before changing their skills. A changed snapshot is rejected when recovering an existing run; restore the previous skill files to resume it.

## Try the included skill

The repository includes Anthropic's unmodified `internal-comms` skill in `skills/internal-comms/`, with its Apache-2.0 license. Its source revision is recorded in `skills/README.md`. It is discovered automatically when you run the starter from this repository.

Try: “Write a weekly 3P update for the Atlas team, covering 26–30 October 2026. Progress: shipped search to 120 users and fixed 8 bugs. Plans: expand to 300 users next week. Problems: waiting for vendor credentials.”

The model can discover the skill from the request, read `SKILL.md`, load `examples/3p-updates.md`, and draft the update. No external integrations are needed when you supply the facts. To reuse the example outside this repository, copy the complete folder, including its license, into your application's `skills/` directory.

## Reuse existing skills

Copy a standard skill folder unchanged from another product, including its references. The name in its YAML frontmatter must match its folder name. Nested category folders are supported; duplicate skill names fail startup rather than silently choosing a copy.

The shared format is used by [Codex](https://learn.chatgpt.com/docs/build-skills), [Claude](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) and [Cursor](https://cursor.com/help/customization/skills). Compatibility covers the standard instructions and text resources, not every feature of those products:

| Content                                                                       | Yada behavior                                                                                              |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| YAML `name`, `description`, Markdown instructions                             | Validated and loaded without conversion.                                                                   |
| `license`, `metadata`, `compatibility`                                        | Accepted; compatibility requirements are shown to the model.                                               |
| Referenced text files                                                         | Read on demand through `yada_read_skill`, using paths relative to the skill folder.                        |
| Scripts                                                                       | Source can be read. Execution only through a host-supplied runner (see below). Nothing runs automatically. |
| Binary assets                                                                 | Remain in the folder; not exposed by the text-reading tool. Supply an asset tool if needed.                |
| `allowed-tools` (space/comma-separated string or YAML list)                   | Parsed into `skill.allowedTools`; never enforced. Feed it to `applyToolPolicy` yourself if wanted.         |
| Hooks, model overrides, invocation flags, other vendor fields                 | Not enforced; returned as startup warnings. Yada's host permissions and approvals remain authoritative.    |
| `agents/openai.yaml` (Codex/ChatGPT: `interface`, `policy`, `dependencies`)   | Loads without error and is readable as a text resource; its settings are not installed or applied.         |
| Missing `name` (Claude allows it)                                             | Defaults to the folder name. `description` is still required.                                              |
| Tool names such as `Bash` or `Read`                                           | Not automatically mapped to Yada tools. Supply appropriate tools or adapt the instructions.                |
| Cursor rules, `CLAUDE.md`, `AGENTS.md`, Markdown without required frontmatter | Not skill formats supported by this loader.                                                                |

`allowed-tools` is advisory input for the host. Yada's `applyToolPolicy` and approvals remain the only enforcement.

Review product-specific restrictions before importing a skill. In particular, do not rely on a skill's invocation flags or `allowed-tools` field to enforce access control. A skill requiring a missing integration cannot complete that workflow until the host provides it.

## Use the SDK

```ts
import { loadSkills, createWorker } from "@edgaralochi/yada";

const skills = await loadSkills({
  directories: ["./skills"],
  authorize: async (identity) => identity.tenantId === "your-tenant",
});

const worker = createWorker({
  storage,
  profiles: {
    assistant: {
      provider,
      system: "Help the user.\n" + skills.system,
      tools: [...applicationTools, ...skills.tools],
    },
  },
});
```

Inspect `skills.warnings` when composing your host; the starter prints them at startup. Include both `skills.system` and `skills.tools`. The system text includes a content fingerprint that binds durable runs to the loaded snapshot. Keep the `yada_read_skill` tool name reserved.

Load only skills reviewed by the host developer. Catalog descriptions are visible to every user of that profile; use separate profiles/catalogs for private tenant-specific skills. The authorization callback gates resource reads, not catalog visibility. Skill reads use existing tool-call, context and cancellation limits; skills cannot add permissions, bypass write approvals, or create new tools.

The loader reads trusted local directories, not uploaded archives or remote repositories. It rejects symlinks within discovered roots, malformed metadata, invalid UTF-8 and oversized text. Limits are 50 skills, eight directory levels, 256 directory entries per skill (including hidden and non-text files), 64 KiB per text file, 2 MiB of text per skill and 8 MiB per catalog. Hidden files are excluded. Supported text extensions are `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.py`, `.sh`, `.js`, `.mjs`, `.ts`, `.html`, `.css` and `.svg`.

## Chunked reads

`yada_read_skill` takes optional `offset` and `limit` (characters; default and maximum 16,000). The result has `content`, `offset`, `total` and, while more remains, `nextOffset`; the model continues with `offset=nextOffset`. Each response stays under 30,000 characters even for escape-heavy text, so files up to 64 KiB fit within the runtime's tool output cap.

## Reload

```ts
await skills.reload();
```

`reload()` re-reads the directories and swaps the whole snapshot at once: an in-flight read sees either the old or the new content, never a mix. If scanning fails, it rejects and the previous snapshot stays. `skills.tools` keeps its identity (its contents change if skills appear or vanish), but `skills.system`, `skills.warnings` and `skills.skills` are getters; re-read `skills.system` after reloading, because it carries the new snapshot fingerprint. Durable runs created against the old fingerprint are rejected on recovery, so reload only between runs.

## Script runner

Pass `runner` to expose scripts. Yada ships no sandbox; isolation, resource limits, network access and interpreter choice are the host's responsibility.

```ts
const skills = await loadSkills({
  directories: ["./skills"],
  authorize,
  runner: async ({ skill, path, args, signal }) =>
    runInSandbox(join(skill.directory, path), args, signal),
});
```

With a runner, `skills.tools` also contains `yada_run_skill_script`, wrapped with `confirmTool` so every call needs approval. It accepts only text files in the loaded snapshot under the skill's `scripts/` directory; other paths, `..` segments, absolute paths and files replaced by symlinks after loading are rejected before the runner is called. Without a runner the tool does not exist. `stdout` and `stderr` are cut at 12,000 characters each. Keep the `yada_run_skill_script` name reserved.

`skills.skills` lists `{ name, description, compatibility?, allowedTools }` per skill.
