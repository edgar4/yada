import { expect, it } from "vitest";
import { once } from "node:events";
import { z } from "zod";
import { storageFixture } from "./helpers/storage.js";
import { createHandler } from "../src/service/http.js";
import { createNodeServer } from "../src/service/node.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { eventSchema } from "../src/service/contracts.js";
async function setup() {
  const s = await storageFixture("sqlite");
  const handler = createHandler({
    storage: s.storage,
    origins: ["https://host.example"],
    authenticate: (req) =>
      Promise.resolve(
        req.headers.get("authorization") === "Bearer valid"
          ? s.identity
          : undefined,
      ),
    authorizeProfile: (_identity, profile) => Promise.resolve(profile === "v1"),
  });
  const request = (path: string, init: RequestInit = {}) =>
    handler(
      new Request(`http://localhost/v1/conversations/chat/runs${path}`, {
        ...init,
        headers: {
          authorization: "Bearer valid",
          "content-type": "application/json",
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    );
  return { ...s, handler, request };
}
it("enforces authentication, origin, profile and input boundaries", async () => {
  const s = await setup();
  expect(
    (await s.request("", { headers: { authorization: "invalid" } })).status,
  ).toBe(401);
  expect(
    (await s.request("", { headers: { origin: "https://evil.example" } }))
      .status,
  ).toBe(403);
  expect(
    (
      await s.request("", {
        method: "OPTIONS",
        headers: { origin: "https://host.example" },
      })
    ).headers.get("access-control-allow-origin"),
  ).toBe("https://host.example");
  expect(
    (
      await s.request("", {
        method: "POST",
        body: JSON.stringify({ id: "a", input: "Hi", profileId: "bad" }),
      })
    ).status,
  ).toBe(403);
  expect((await s.request("", { method: "POST", body: "{" })).status).toBe(400);
  expect(
    (await s.request("", { method: "POST", body: "x".repeat(65537) })).status,
  ).toBe(413);
  expect((await s.request("missing")).status).toBe(404);
  expect((await s.request("", { method: "GET" })).status).toBe(405);
  const body = JSON.stringify({ id: "a", input: "Hi", profileId: "v1" });
  expect((await s.request("", { method: "POST", body })).status).toBe(202);
  expect(
    (
      await s.request("", {
        method: "POST",
        body: body.replace('"Hi"', '"Changed"'),
      })
    ).status,
  ).toBe(409);
  expect((await s.request("/a", { method: "DELETE" })).status).toBe(405);
  expect((await s.request("/a/events?after=99")).status).toBe(409);
  expect((await s.request("/a/events?after=-1")).status).toBe(400);
  expect((await s.request("/a/cancel", { method: "POST" })).status).toBe(202);
  expect(
    (await s.storage.jobs.load(s.identity, "chat", "a"))?.cancelRequested,
  ).toBe(true);
});
it("streams ordered replay through a real HTTP server and disconnect does not cancel runs", async () => {
  const s = await setup();
  const server = createNodeServer(s.handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const base = `http://127.0.0.1:${String(address.port)}/v1/conversations/chat/runs`;
  const headers = {
    authorization: "Bearer valid",
    "content-type": "application/json",
  };
  try {
    expect(
      (
        await fetch(base, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "a", input: "Hi", profileId: "v1" }),
        })
      ).status,
    ).toBe(202);
    const response = await fetch(`${base}/a/events`, { headers });
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value).toBeDefined();
    await reader?.cancel();
    expect(
      (await s.storage.jobs.load(s.identity, "chat", "a"))?.cancelRequested,
    ).toBe(false);
    const worker = createWorker({
      storage: s.storage,
      profiles: {
        v1: {
          provider: createFakeProvider(() => ({
            content: "Hello",
            toolCalls: [],
            finishReason: "stop",
          })),
          tools: [],
          system: "Help",
        },
      },
    });
    await worker.tick();
    const replay = await fetch(`${base}/a/events?after=1`, { headers });
    const events = z.array(eventSchema).parse(
      (await replay.text())
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line)),
    );
    expect(events[0]?.sequence).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "Hello" });
    expect((await fetch(`${base}/a`, { headers })).status).toBe(200);
    await worker.stop();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
it("serves opaque approval previews and binds decisions to their run", async () => {
  const s = await setup();
  await s.storage.jobs.submit(s.identity, "chat", {
    id: "a",
    input: "Hi",
    profileId: "v1",
  });
  await s.storage.actions.propose(s.identity, {
    id: "approval",
    runId: JSON.stringify(["chat", "a"]),
    callId: "call",
    tool: "rename",
    toolVersion: "v1",
    args: { token: "private" },
    preview: "Rename record",
    version: "1",
    expiresAt: Date.now() + 60000,
    status: "pending",
  });
  const preview = await s.request("/a/approvals/approval");
  expect(preview.status).toBe(200);
  expect(await preview.text()).not.toContain("private");
  expect((await s.request("/a/approvals/missing")).status).toBe(404);
  expect(
    (await s.request("/a/approvals/approval", { method: "POST" })).status,
  ).toBe(405);
  expect(
    (
      await s.request("/a/approvals/approval/decision", {
        method: "POST",
        body: JSON.stringify({ approved: true }),
      })
    ).status,
  ).toBe(202);
  expect((await s.storage.actions.load(s.identity, "approval"))?.status).toBe(
    "approved",
  );
  expect(
    (
      await s.request("/a/approvals/approval/decision", {
        method: "POST",
        body: JSON.stringify({ approved: false }),
      })
    ).status,
  ).toBe(503);
});
it("terminates event streams when access is revoked and hides dependency errors", async () => {
  const s = await setup();
  await s.storage.jobs.submit(s.identity, "chat", {
    id: "a",
    input: "Hi",
    profileId: "v1",
  });
  let allowed = true;
  const handler = createHandler({
    storage: s.storage,
    origins: [],
    authenticate: () =>
      allowed ? Promise.resolve(s.identity) : Promise.resolve(undefined),
    authorizeProfile: () => Promise.resolve(true),
  });
  const response = await handler(
    new Request("http://localhost/v1/conversations/chat/runs/a/events"),
  );
  const reader = response.body?.getReader();
  await reader?.read();
  allowed = false;
  await expect(reader?.read()).rejects.toThrow("disconnected");
  const unavailable = createHandler({
    storage: s.storage,
    origins: [],
    authenticate: () => Promise.reject(new Error("database-password")),
    authorizeProfile: () => Promise.resolve(true),
  });
  const failure = await unavailable(new Request("http://localhost/"));
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("password");
});
it("bridges empty responses and failed handlers without leaking errors", async () => {
  const server = createNodeServer((req) =>
    req.url.endsWith("/error")
      ? Promise.reject(new Error("private"))
      : Promise.resolve(new Response(null, { status: 204 })),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  try {
    expect(
      (await fetch(`http://127.0.0.1:${String(address.port)}/`)).status,
    ).toBe(204);
    expect(
      (await fetch(`http://127.0.0.1:${String(address.port)}/error`)).status,
    ).toBe(503);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
