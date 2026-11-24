# Terminal coding agent

`yada` is also a coding agent for your terminal. It reads, searches and edits code and runs commands in the current directory, and it asks before it changes anything.

## Install and configure

```sh
npm install -g @edgaralochi/yada ink react
```

`ink` and `react` are optional. Without them, `yada` uses the line interface.

Set the model with the usual settings, in the environment or in `~/.yada/.env`:

```sh
YADA_LLM_PROVIDER=anthropic
YADA_LLM_MODEL=claude-opus-5-5
YADA_LLM_API_KEY=...
```

Every provider Yada supports works, including Ollama and llama.cpp.

## Use

```sh
yada                          # full-screen interface in the current directory
yada "fix the failing test"   # start with a prompt
yada -c                       # continue the latest session here
yada --resume <id>            # resume a session by id
yada --plain                  # line interface
yada -p "explain src/index.ts"            # print one answer and exit
yada -p "fix the lint errors" --mode auto  # unattended, for scripts and CI
```

In a session:

| Command         | Does                                                   |
| --------------- | ------------------------------------------------------ |
| `/clear`        | Start a new session                                    |
| `/undo`         | Revert the file edits of the latest turn that made any |
| `/resume [n]`   | List this directory's sessions, or resume number n     |
| `/mode <mode>`  | Change the permission mode                             |
| `/model <name>` | Switch model                                           |
| `/exit`         | Quit                                                   |

Ctrl+C or Esc stops the current turn. Ctrl+C on an empty prompt quits.

## Permission modes

| Mode        | Reads | File edits | Shell commands |
| ----------- | ----- | ---------- | -------------- |
| `ask`       | yes   | asks       | asks           |
| `auto-edit` | yes   | yes        | asks           |
| `auto`      | yes   | yes        | yes            |
| `read-only` | yes   | no         | no             |

`ask` is the default. `-p` defaults to `read-only`, since nobody is there to approve. Answering "always" allows that tool for the rest of the session. Every edit and new file shows a diff first. Paths outside the project, including through symlinks, are refused. `/undo` restores files only; it cannot undo shell commands.

## Tools

| Tool         | Effect                                                         |
| ------------ | -------------------------------------------------------------- |
| `read_file`  | Read numbered lines, with offset and limit                     |
| `list_files` | Glob files, skipping `node_modules` and `.git`                 |
| `grep`       | Regex search; uses ripgrep and `.gitignore` when installed     |
| `edit_file`  | Replace an exact, unique string                                |
| `write_file` | Create or overwrite a file                                     |
| `bash`       | Run a command in the project, with a timeout and capped output |

Skills in `.claude/skills`, `.agents/skills` and `~/.yada/skills` are loaded too.

## Context and sessions

The system prompt includes the working directory, the git branch, status and recent commits, and the contents of `~/.yada/YADA.md`, `AGENTS.md`, `CLAUDE.md` and `YADA.md` in the project. Long sessions are summarized automatically.

Sessions are saved as JSON in `~/.yada/sessions`, readable only by you. Set `YADA_HOME` to use another directory.

## In your own agents

The same pieces are exported from `@edgaralochi/yada/coding`:

```ts
import { codingTools, createCodingAgent } from "@edgaralochi/yada/coding";

const tools = codingTools({ root: "/srv/repo" });

const agent = await createCodingAgent({
  root: process.cwd(),
  provider,
  mode: "auto-edit",
  approve: async ({ tool, preview }) =>
    (await confirm(tool, preview)) ? "yes" : "no",
  onEvent: (event) => {
    /* stream text_delta, tool_started, tool_finished */
  },
});
await agent.send("Add a test for parseConfig", AbortSignal.timeout(600_000));
```

`edit_file`, `write_file` and `bash` are write tools, so in `run()` they go through `executeWrite` like any other approved action.
