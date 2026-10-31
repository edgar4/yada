---
layout: doc
title: "Starter app"
description: "Run a complete Yada assistant with a real model provider, optional password protection, encrypted storage, scoped tools and the browser widget."
---

# Starter app

The starter is a complete, project-independent assistant for one shared workspace. It combines Yada's provider adapters, durable worker, encrypted storage, typed tools and browser widget. It runs on Node 24.

## Create a standalone app

```sh
npx @edgaralochi/yada init my-assistant
cd my-assistant
```

The initializer installs dependencies and creates the starter source, `.env.starter` with a private encryption key, `.gitignore`, and a `skills/` folder. Set your provider credentials, then run `npm start`. The generated app uses the same starter implementation as this repository and pins the Yada version used to initialize it.

Omitting the directory creates `yada-app`. The destination must not exist and its parent directory must exist; existing files and projects are never overwritten. To use it alongside an existing application, choose a new subdirectory.

Use `--no-install` to generate files without installing dependencies, then run `npm install` yourself. If installation fails, the initializer retains the generated files and config so you can retry `npm install` in the new directory. It does not start the server or contact your model provider.

If Yada is already installed in your project, run `npx yada init my-assistant`. To test an unpublished tarball, run `npm exec --package=/absolute/path/yada.tgz -- yada init my-assistant --no-install`, then install that same tarball inside `my-assistant` with `npm install /absolute/path/yada.tgz` before `npm start`.

## Run from source

```sh
npm ci
npm run starter:init
```

Open the generated `.env.starter` and set your provider configuration:

```dotenv
YADA_LLM_PROVIDER=anthropic
YADA_LLM_MODEL=claude-sonnet-4-6
YADA_LLM_API_KEY=your-provider-api-key
```

Then run:

```sh
npm run starter
```

Open `http://localhost:3000` to open the chat directly. Ask “What time is it?” or “How do I configure this starter?” to exercise its tools. Provider calls use your provider account. See [provider configuration](configuration.md) for OpenAI, Gemini, DeepSeek, Ollama and llama.cpp settings.

Initialization generates the storage encryption key in a private file. It refuses to overwrite existing configuration. Retain that file securely: changing the storage key prevents access to existing records. SQLite data lives in `work/starter/yada.sqlite`; no database server is needed.

## Configuration

| Setting                                                   | Default or purpose                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `YADA_LLM_PROVIDER`, `YADA_LLM_MODEL`, `YADA_LLM_API_KEY` | Your model provider and its credentials.                           |
| `YADA_STARTER_PASSWORD`                                   | Optional password (24–256 characters); unset or empty skips login. |
| `YADA_STORAGE_KEY`                                        | Generated 64-character hexadecimal encryption key.                 |
| `PORT`                                                    | `3000`; also sets the default localhost browser origin.            |
| `YADA_STARTER_ORIGIN`                                     | Exact browser origin, such as `https://assistant.example.com`.     |
| `YADA_STORAGE_DRIVER`                                     | `sqlite`; also supports `postgres` and `mysql`.                    |
| `YADA_STORAGE_FILE`                                       | SQLite filename; defaults to `work/starter/yada.sqlite`.           |
| `YADA_STORAGE_URL`                                        | Connection URL when using PostgreSQL or MySQL.                     |
| `YADA_MCP_SERVERS`                                        | Optional existing [MCP server configuration](mcp.md).              |

Provider credentials, storage keys and MCP tokens remain on the server. There is no provider-secret field in the browser. The starter uses a real configured provider; tests inject deterministic responses separately.

Skills are discovered automatically from project skill folders. See [skills](skills.md) to reuse `SKILL.md` packages from other agents or set the optional `YADA_SKILLS_DIR` directory override.

## Authentication and persistence

By default, the starter opens without login. Leave `YADA_STARTER_PASSWORD` unset or empty for this mode. Anyone who can reach the starter can use its provider account, access the shared workspace and invoke its configured tools. Use password protection or your host’s authentication when access should be restricted.

To enable login, add `YADA_STARTER_PASSWORD` with a 24–256 character password to `.env.starter` and restart. Remove it or set it empty to disable login. Signed session cookies expire after eight hours, are HttpOnly and SameSite=Strict, and use Secure on HTTPS. Login attempts are bounded. Mutations require the configured browser origin. In password-protected mode, logout revokes that session; restarting the server invalidates sessions and requires login again. Without a password, the chat opens directly and has no sign-out button.

Conversations and unfinished runs remain durable across restarts. Reloading the browser resumes its saved run instead of submitting it again. Logging out disconnects the interface; use **Cancel run** to cancel work already submitted.

This starter does not implement multiple user accounts. In a multi-user host, replace the starter authentication with your verified session identity and permissions; keep the existing Yada service authorization boundary. See [service composition](service.md).

## Adapt it

`examples/starter/tools.ts` contains two scoped read tools: UTC time and a configuration guide. Replace or extend them with your application's typed tools. `app.ts` composes the provider, worker, authentication and optional MCP connections through Yada's public APIs. The UI reuses `@edgaralochi/yada/widget` and `@edgaralochi/yada/client`.

Configured MCP tools inherit the starter workspace identity. Add only servers you trust and explicitly review any write mappings. The widget displays the existing approval flow; MCP writes still require the [server compatibility contract](mcp.md#approved-writes).

Finish or cancel active runs before changing their provider, tools or execution limits. Recovery requires the configuration that created an unfinished run; restore that configuration if a change leaves a run waiting.

The packaged initializer copies these same files into your new project. Its imports use Yada's public exports; generated assets and SQLite data stay under the working directory's `work/starter/` folder. Add your own skill folders under the generated `skills/` directory; the repository's Anthropic example is not included automatically.

## Deploy it

The server listens on `127.0.0.1`. Put an HTTPS reverse proxy in front of it and set `YADA_STARTER_ORIGIN` to the public origin. Forward the event stream without buffering. Use persistent storage, preserve the encryption key, and follow [backup and recovery guidance](operations.md). SIGINT and SIGTERM stop admission and the worker, close MCP connections, and close storage.

The default profile bounds each run to eight model rounds, sixteen tool calls and sixty seconds. Configure spending limits and monitoring for your host before expanding access. For multiple worker processes or multiple accounts, supply the host's shared authentication rather than this process-local starter session store.
