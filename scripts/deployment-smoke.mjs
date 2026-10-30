import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const name = `yada-deployment-smoke-${randomBytes(6).toString("hex")}`;
const image = `${name}:test`;
const volume = `${name}-data`;
const env = {
  ...process.env,
  YADA_DEMO_TOKEN: randomBytes(32).toString("hex"),
  YADA_STORAGE_KEY: randomBytes(32).toString("hex"),
};
const docker = (...args) =>
  execFileSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
const headers = {
  authorization: `Bearer ${env.YADA_DEMO_TOKEN}`,
  "content-type": "application/json",
};
let base;
const request = (path, options = {}) =>
  globalThis.fetch(`${base}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
    signal: AbortSignal.timeout(15_000),
  });
async function ready() {
  base = `http://${docker("port", name, "3000/tcp")}/v1/conversations/smoke/runs`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request("").catch(() => undefined);
    if (response?.status === 405) return;
    await delay(100);
  }
  throw new Error("Container did not become ready");
}
function stop() {
  docker("stop", "--time", "5", name);
  assert.equal(
    docker("inspect", "--format", "{{.State.ExitCode}}", name),
    "0",
    "SIGTERM must exit without a forced kill",
  );
}

try {
  docker("build", "--tag", image, ".");
  docker("volume", "create", volume);
  docker(
    "run",
    "--detach",
    "--init",
    "--name",
    name,
    "--publish",
    "127.0.0.1::3000",
    "--env",
    "YADA_DEMO_TOKEN",
    "--env",
    "YADA_STORAGE_KEY",
    "--env",
    "YADA_STORAGE_FILE=/data/yada.sqlite",
    "--volume",
    `${volume}:/data`,
    image,
  );
  await ready();
  assert.equal(
    (await request("", { headers: { authorization: "Bearer invalid" } }))
      .status,
    401,
  );
  assert.equal(
    (await request("", { headers: { origin: "https://denied.example" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("", {
        method: "POST",
        body: JSON.stringify({
          id: "completed",
          input: "Hello",
          profileId: "demo",
        }),
      })
    ).status,
    202,
  );
  const events = (await (await request("/completed/events")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "completed");
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  const saved = await (await request("/completed")).json();
  assert.equal(saved.status, "completed");
  docker(
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `
    import {createStorage,storageConfigFromEnv} from "@edgaralochi/yada";
    const storage=await createStorage(storageConfigFromEnv(process.env));
    await storage.jobs.submit({actorId:"demo",tenantId:"demo"},"smoke",{id:"waiting",input:"Wait",profileId:"unconfigured"});
    await storage.close();
  `,
  );
  const live = await request("/waiting/events");
  const reader = live.body.getReader();
  assert.equal(
    JSON.parse(new TextDecoder().decode((await reader.read()).value)).type,
    "queued",
  );
  const disconnected = reader.read();
  const ended = disconnected.then(
    () => true,
    () => true,
  );
  stop();
  await ended;
  docker("start", name);
  await ready();
  assert.deepEqual(await (await request("/completed")).json(), saved);
  const replay = (
    await (await request(`/completed/events?after=${events.length - 1}`)).text()
  ).trim();
  assert.deepEqual(JSON.parse(replay), events.at(-1));
  assert.equal(
    (await (await request("/waiting")).json()).cancelRequested,
    false,
  );
  stop();
  console.log(
    "Container authentication, events, persistence and open-stream SIGTERM passed",
  );
} finally {
  for (const args of [
    ["rm", "--force", name],
    ["volume", "rm", volume],
    ["image", "rm", image],
  ]) {
    try {
      docker(...args);
    } catch {
      continue;
    }
  }
}
