import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function waitFor(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error("Starter did not become ready");
}

export async function verifyStarter(root, directory, execute, npm) {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  execute(
    npm,
    [
      "install",
      "--no-audit",
      "--no-fund",
      `zod@${manifest.dependencies.zod}`,
      `tsx@${manifest.devDependencies.tsx}`,
      `esbuild@${manifest.devDependencies.esbuild}`,
    ],
    directory,
  );
  await cp(join(root, "examples/starter"), directory, { recursive: true });
  execute(process.execPath, ["init.mjs"], directory);
  execute(process.execPath, ["build.mjs"], directory);
  const password = (
    await readFile(join(directory, ".env.starter"), "utf8")
  ).match(/^YADA_STARTER_PASSWORD=(.+)$/m)?.[1];
  assert(password);
  let calls = 0;
  const provider = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer local-test");
    request.resume();
    calls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "starter-smoke",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Installed starter works." },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  const providerPort = await listen(provider);
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const origin = `http://127.0.0.1:${String(port)}`;
  let child;
  let ended;
  let output = "";
  const start = async () => {
    child = spawn(
      process.execPath,
      ["--env-file=.env.starter", "--import", "tsx", "server.ts"],
      {
        cwd: directory,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("YADA_"),
            ),
          ),
          PORT: String(port),
          YADA_STARTER_ORIGIN: origin,
          YADA_LLM_PROVIDER: "ollama",
          YADA_LLM_MODEL: "fixture",
          YADA_LLM_API_KEY: "local-test",
          YADA_LLM_BASE_URL: `http://127.0.0.1:${String(providerPort)}/v1`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    ended = once(child, "exit");
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    await waitFor(async () => {
      if (child.exitCode !== null)
        throw new Error("Starter process exited before readiness");
      return globalThis
        .fetch(origin)
        .then((response) => response.ok)
        .catch(() => false);
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      assert.equal((await ended)[0], 0);
    } finally {
      clearTimeout(timer);
    }
  };
  const login = async () => {
    const response = await globalThis.fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    return cookie;
  };
  try {
    await start();
    assert.equal(
      (await globalThis.fetch(`${origin}/assets/client.js`)).status,
      200,
    );
    const cookie = await login();
    const run = `${origin}/v1/conversations/smoke/runs`;
    assert.equal(
      (
        await globalThis.fetch(run, {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: JSON.stringify({
            id: "installed",
            profileId: "starter",
            input: "Hello",
          }),
        })
      ).status,
      202,
    );
    await waitFor(
      async () =>
        (
          await (
            await globalThis.fetch(`${run}/installed`, { headers: { cookie } })
          ).json()
        ).status === "completed",
    );
    assert.equal(calls, 1);
    await stop();
    await start();
    assert.equal(
      (
        await globalThis.fetch(`${origin}/auth/session`, {
          headers: { cookie },
        })
      ).status,
      401,
    );
    const fresh = await login();
    assert.equal(
      (
        await globalThis.fetch(`${run}/installed`, {
          headers: { cookie: fresh },
        })
      ).status,
      200,
    );
    assert.match(
      await (
        await globalThis.fetch(`${run}/installed/events`, {
          headers: { cookie: fresh },
        })
      ).text(),
      /Installed starter works/,
    );
    assert.equal(calls, 1);
    assert(!output.includes(password));
  } finally {
    try {
      await stop();
    } finally {
      await close(provider);
    }
  }
}
