---
layout: doc
title: "Starter app"
description: "Run a complete Yada assistant with a real model provider, password authentication, encrypted storage, scoped tools and the browser widget."
---

# Starter app

The starter is a complete, project-independent assistant for one authenticated workspace. It combines Yada's provider adapters, durable worker, encrypted storage, typed tools and browser widget. It runs on Node 24.

## Run it

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

Open `http://localhost:3000` and sign in with `YADA_STARTER_PASSWORD` from `.env.starter`. Ask “What time is it?” or “How do I configure this starter?” to exercise its tools. Provider calls use your provider account. See [provider configuration](configuration.md) for OpenAI, Gemini, DeepSeek, Ollama and llama.cpp settings.

Initialization generates the login password and storage encryption key in a private file. It refuses to overwrite existing configuration. Retain that file securely: changing the storage key prevents access to existing records. SQLite data lives in `work/starter/yada.sqlite`; no database server is needed.

## Configuration

| Setting                                                   | Default or purpose                                             |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `YADA_LLM_PROVIDER`, `YADA_LLM_MODEL`, `YADA_LLM_API_KEY` | Your model provider and its credentials.                       |
| `YADA_STARTER_PASSWORD`                                   | Generated login password, at least 24 characters.              |
| `YADA_STORAGE_KEY`                                        | Generated 64-character hexadecimal encryption key.             |
| `PORT`                                                    | `3000`; also sets the default localhost browser origin.        |
| `YADA_STARTER_ORIGIN`                                     | Exact browser origin, such as `https://assistant.example.com`. |
| `YADA_STORAGE_DRIVER`                                     | `sqlite`; also supports `postgres` and `mysql`.                |
| `YADA_STORAGE_FILE`                                       | SQLite filename; defaults to `work/starter/yada.sqlite`.       |
| `YADA_STORAGE_URL`                                        | Connection URL when using PostgreSQL or MySQL.                 |
| `YADA_MCP_SERVERS`                                        | Optional existing [MCP server configuration](mcp.md).          |

Provider credentials, storage keys and MCP tokens remain on the server. There is no provider-secret field in the browser. The starter uses a real configured provider; tests inject deterministic responses separately.

## Authentication and persistence

The generated password protects a single workspace. Signed session cookies expire after eight hours, are HttpOnly and SameSite=Strict, and use Secure on HTTPS. Login attempts are bounded. Mutations require the configured browser origin. Logout revokes that session; restarting the server invalidates all sessions and requires login again.

Conversations and unfinished runs remain durable across restarts. Reloading the browser resumes its saved run instead of submitting it again. Logging out disconnects the interface; use **Cancel run** to cancel work already submitted.

This starter does not implement multiple user accounts. In a multi-user host, replace the starter authentication with your verified session identity and permissions; keep the existing Yada service authorization boundary. See [service composition](service.md).

## Adapt it

`examples/starter/tools.ts` contains two scoped read tools: UTC time and a configuration guide. Replace or extend them with your application's typed tools. `app.ts` composes the provider, worker, authentication and optional MCP connections through Yada's public APIs. The UI reuses `yada/widget` and `yada/client`.

Configured MCP tools inherit the starter workspace identity. Add only servers you trust and explicitly review any write mappings. The widget displays the existing approval flow; MCP writes still require the [server compatibility contract](mcp.md#approved-writes).

Finish or cancel active runs before changing their provider, tools or execution limits. Recovery requires the configuration that created an unfinished run; restore that configuration if a change leaves a run waiting.

To reuse the starter outside this repository, copy the contents of `examples/starter/` into a new ESM project, install a [Yada tarball](deployment.md), `zod`, `tsx` and `esbuild`, then run `node init.mjs`, `node build.mjs` and `node --env-file=.env.starter --import tsx server.ts`. Its imports use Yada's public package exports; generated assets and SQLite data stay under the working directory's `work/starter/` folder.

## Deploy it

The server listens on `127.0.0.1`. Put an HTTPS reverse proxy in front of it and set `YADA_STARTER_ORIGIN` to the public origin. Forward the event stream without buffering. Use persistent storage, preserve the encryption key, and follow [backup and recovery guidance](operations.md). SIGINT and SIGTERM stop admission and the worker, close MCP connections, and close storage.

The default profile bounds each run to eight model rounds, sixteen tool calls and sixty seconds. Configure spending limits and monitoring for your host before expanding access. For multiple worker processes or multiple accounts, supply the host's shared authentication rather than this process-local starter session store.
