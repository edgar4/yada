import { expect, it, vi } from "vitest";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { storageFixture } from "./helpers/storage.js";
import { createHandler } from "../src/service/http.js";
import { closeNodeServer, createNodeServer } from "../src/service/node.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { operationId } from "../src/storage/actions.js";

async function setup(extra: Partial<Parameters<typeof createHandler>[0]> = {}) {
  const s = await storageFixture("sqlite");
  const handler = createHandler({
    storage: s.storage,
    origins: ["https://host.example"],
    authenticate: () => Promise.resolve(s.identity),
    authorizeProfile: () => Promise.resolve(true),
    ...extra,
  });
  const call = (path: string, init: RequestInit = {}) =>
    handler(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    );
  const submit = (id: string, conversation = "chat", input = "Hi") =>
    call(`/v1/conversations/${conversation}/runs`, {
      method: "POST",
      body: JSON.stringify({ id, input, profileId: "v1" }),
    });
  return { ...s, handler, call, submit };
}

it("serves health probes before auth and reports storage failures", async () => {
  const onError = vi.fn();
  const s = await setup({
    authenticate: () => Promise.resolve(undefined),
    onError,
  });
  expect((await s.call("/healthz")).status).toBe(200);
  expect((await s.call("/readyz")).status).toBe(200);
  await s.storage.close();
  expect((await s.call("/readyz")).status).toBe(503);
  expect(onError).toHaveBeenCalledOnce();
});

it("maps permanent client errors and exposes Retry-After", async () => {
  const onError = vi.fn();
  const s = await setup({ onError });
  const path = "/v1/conversations/chat/runs";
  expect(
    (
      await s.call(path, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      })
    ).status,
  ).toBe(415);
  expect((await s.call(path, { method: "POST" })).status).toBe(400);
  expect((await s.submit("a")).status).toBe(202);
  await s.storage.jobs.update(
    s.identity,
    "chat",
    "a",
    { type: "cancelled" },
    { status: "cancelled" },
  );
  await s.storage.retention.eraseConversation(s.identity, "chat");
  expect((await s.submit("b")).status).toBe(410);
  expect(onError).not.toHaveBeenCalled();
  const preflight = await s.call(path, {
    method: "OPTIONS",
    headers: { origin: "https://host.example" },
  });
  expect(preflight.headers.get("access-control-expose-headers")).toBe(
    "Retry-After",
  );
});

it("does not burn quota on conflicts", async () => {
  const s = await setup({
    quota: { requests: { limit: 2, windowMs: 60_000 } },
  });
  expect((await s.submit("a")).status).toBe(202);
  expect((await s.submit("b")).status).toBe(409);
  expect((await s.submit("b")).status).toBe(409);
  expect((await s.submit("a")).status).toBe(202);
  await s.storage.jobs.update(
    s.identity,
    "chat",
    "a",
    { type: "cancelled" },
    { status: "cancelled" },
  );
  expect((await s.submit("b")).status).toBe(202);
  expect((await s.submit("c", "other")).status).toBe(429);
});

it("limits requests and concurrent streams per actor", async () => {
  const s = await setup({
    limits: { requestsPerMinute: 3, streamsPerActor: 1 },
  });
  expect((await s.submit("a")).status).toBe(202);
  const stream = await s.call("/v1/conversations/chat/runs/a/events");
  expect(stream.status).toBe(200);
  const second = await s.call("/v1/conversations/chat/runs/a/events");
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).toBe("1");
  await stream.body?.cancel();
  const third = await s.call("/v1/conversations/chat/runs/a/events");
  expect(third.status).toBe(200);
  await third.body?.cancel();
  expect((await s.call("/v1/conversations/chat/runs/a")).status).toBe(429);
});

it("lists, reads and erases conversations including remembered grants", async () => {
  const s = await setup();
  for (const name of ["one", "two", "three"]) {
    await s.submit("r", name, `Hello ${name}`);
    await s.storage.jobs.update(
      s.identity,
      name,
      "r",
      { type: "completed", text: "Done" },
      { status: "completed", text: "Done" },
    );
  }
  await s.submit("f", "failed");
  await s.storage.jobs.update(
    s.identity,
    "failed",
    "f",
    { type: "failed", code: "timeout" },
    { status: "failed", code: "timeout" },
  );
  const stranger = createHandler({
    storage: s.storage,
    origins: [],
    authenticate: () => Promise.resolve({ ...s.identity, actorId: "stranger" }),
    authorizeProfile: () => Promise.resolve(true),
  });
  const first = (await (await s.call("/v1/conversations?limit=3")).json()) as {
    conversations: { id: string }[];
    next: string;
  };
  expect(first.conversations).toHaveLength(3);
  const rest = (await (
    await s.call(`/v1/conversations?after=${first.next}`)
  ).json()) as { conversations: { id: string }[]; next?: string };
  const ids = [...first.conversations, ...rest.conversations]
    .map((item) => item.id)
    .sort();
  expect(ids).toEqual(["failed", "one", "three", "two"]);
  expect(rest.next).toBeUndefined();
  const theirs = await stranger(
    new Request("http://localhost/v1/conversations"),
  );
  expect(await theirs.json()).toEqual({ conversations: [] });
  expect(await (await s.call("/v1/conversations/one")).json()).toEqual({
    id: "one",
    messages: [
      { role: "user", content: "Hello one" },
      { role: "assistant", content: "Done" },
    ],
  });
  expect(
    (
      (await (await s.call("/v1/conversations/failed")).json()) as {
        messages: unknown;
      }
    ).messages,
  ).toEqual([
    { role: "user", content: "Hi" },
    { role: "failure", code: "timeout" },
  ]);
  expect((await s.call("/v1/conversations/missing")).status).toBe(404);
  const action = {
    id: operationId(s.identity, JSON.stringify(["one", "r"]), "c1"),
    runId: JSON.stringify(["one", "r"]),
    callId: "c1",
    tool: "t",
    toolVersion: "1",
    args: {},
    preview: "p",
    version: "1",
    expiresAt: Date.now() + 60_000,
    status: "pending" as const,
  };
  await s.storage.actions.propose(s.identity, action);
  const decided = await s.storage.actions.decide(s.identity, action.id, true);
  await s.storage.actions.remember(s.identity, decided, "conversation");
  const remembered = (conversation: string) =>
    s.storage.actions.remembered(
      s.identity,
      JSON.stringify([conversation, "x"]),
      "t",
      "1",
      {},
    );
  expect(await remembered("one")).toBe(true);
  expect(
    (await s.call("/v1/conversations/one", { method: "DELETE" })).status,
  ).toBe(204);
  expect(await remembered("one")).toBe(false);
  expect((await s.call("/v1/conversations/one")).status).toBe(404);
  await s.submit("busy");
  expect(
    (await s.call("/v1/conversations/chat", { method: "DELETE" })).status,
  ).toBe(409);
});

it("resumes a decided approval when the client only polls", async () => {
  const s = await setup();
  await s.submit("a");
  const id = operationId(s.identity, JSON.stringify(["chat", "a"]), "c1");
  await s.storage.actions.propose(s.identity, {
    id,
    runId: JSON.stringify(["chat", "a"]),
    callId: "c1",
    tool: "t",
    toolVersion: "1",
    args: {},
    preview: "p",
    version: "1",
    expiresAt: Date.now() + 60_000,
    status: "pending",
  });
  await s.storage.jobs.update(s.identity, "chat", "a", {
    type: "awaiting_approval",
    approvalId: id,
  });
  await s.storage.actions.decide(s.identity, id, true);
  await s.call("/v1/conversations/chat/runs/a");
  expect((await s.storage.jobs.load(s.identity, "chat", "a"))?.status).toBe(
    "queued",
  );
});

it("posts signed webhooks for terminal and approval events without blocking", async () => {
  const s = await setup();
  const received: { body: string; signature: string | undefined }[] = [];
  const sink = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({
        body,
        signature: req.headers["x-yada-signature"] as string | undefined,
      });
      res.end();
    });
  });
  sink.listen(0, "127.0.0.1");
  await once(sink, "listening");
  const address = sink.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const secret = "s".repeat(32);
  const worker = createWorker({
    storage: s.storage,
    profiles: {
      v1: {
        provider: createFakeProvider(() => ({
          content: "Hi",
          toolCalls: [],
          finishReason: "stop",
        })),
        tools: [],
        system: "Help",
      },
    },
    webhooks: { url: `http://127.0.0.1:${String(address.port)}/hook`, secret },
  });
  try {
    await s.submit("a");
    await worker.tick();
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    const [hook] = received;
    expect(JSON.parse(hook?.body ?? "")).toEqual({
      type: "completed",
      conversationId: "chat",
      runId: "a",
      status: "completed",
    });
    expect(hook?.signature).toBe(
      `sha256=${createHmac("sha256", secret)
        .update(hook?.body ?? "")
        .digest("hex")}`,
    );
  } finally {
    await worker.stop();
    await closeNodeServer(sink, 0);
  }
});

it("applies node server defaults and drains on close", async () => {
  const onError = vi.fn();
  const server = createNodeServer(() => Promise.reject(new Error("boom")), {
    maxConnections: 5,
    onError,
  });
  expect(server.maxConnections).toBe(5);
  expect(server.requestTimeout).toBe(30_000);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  expect(
    (await fetch(`http://127.0.0.1:${String(address.port)}/`)).status,
  ).toBe(503);
  expect(onError).toHaveBeenCalledOnce();
  await closeNodeServer(server);
  expect(server.listening).toBe(false);
});
