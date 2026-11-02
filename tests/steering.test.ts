import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createHandler } from "../src/service/http.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { readTool, writeTool } from "../src/index.js";
import { operationId } from "../src/storage/actions.js";
import { maxSteering } from "../src/service/contracts.js";
import { BrowserClient } from "../src/client/index.js";
import { contentText } from "../src/core/content.js";
import type { ProviderResult } from "../src/index.js";

const call: ProviderResult = {
  content: "",
  toolCalls: [{ id: "c1", name: "look", args: {} }],
  finishReason: "tool_calls",
};
const done: ProviderResult = {
  content: "Done",
  toolCalls: [],
  finishReason: "stop",
};
const look = readTool({
  name: "look",
  description: "Look",
  input: z.strictObject({}),
  authorize: () => Promise.resolve(true),
  execute: () => Promise.resolve("seen"),
});
const userTexts = (messages: readonly { role: string; content?: unknown }[]) =>
  messages
    .filter((turn) => turn.role === "user")
    .map((turn) => contentText(turn.content as string));

for (const driver of drivers)
  describe(`${driver} mid-run steering`, () => {
    const submit = (s: Awaited<ReturnType<typeof storageFixture>>) =>
      s.storage.jobs.submit(s.identity, "chat", {
        id: "one",
        profileId: "v1",
        input: "Start",
      });
    const steer = (
      s: Awaited<ReturnType<typeof storageFixture>>,
      id: string,
      input = id,
    ) => s.storage.jobs.steer(s.identity, "chat", "one", { id, input });

    it("delivers a message at the next round and persists it with the run", async () => {
      const s = await storageFixture(driver);
      await submit(s);
      const provider = createFakeProvider(async (_request, n) => {
        if (n === 1) {
          await steer(s, "m1", "Actually, be brief");
          return call;
        }
        return done;
      });
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [look], system: "Help" } },
      });
      await worker.tick();
      await worker.stop();
      expect(userTexts(provider.requests[0]?.messages ?? [])).toEqual([
        "Start",
      ]);
      expect(userTexts(provider.requests[1]?.messages ?? [])).toEqual([
        "Start",
        "Actually, be brief",
      ]);
      const job = await s.storage.jobs.load(s.identity, "chat", "one");
      expect(job?.status).toBe("completed");
      expect(job?.steering).toMatchObject([{ id: "m1", consumed: true }]);
      expect(job?.events.map((event) => event.type)).toContain(
        "steering_received",
      );
      expect(userTexts(job?.history ?? [])).toEqual([]);
      const next = await s.storage.conversations.load(s.identity, "chat");
      expect(next?.messages.map((turn) => turn.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "user",
        "assistant",
      ]);
    });

    it("continues when a message arrives during the final model call", async () => {
      const s = await storageFixture(driver);
      await submit(s);
      const provider = createFakeProvider(async (_request, n) => {
        if (n === 1) await steer(s, "m1", "One more thing");
        return { ...done, content: n === 1 ? "First" : "Second" };
      });
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [look], system: "Help" } },
      });
      await worker.tick();
      await worker.stop();
      expect(userTexts(provider.requests[1]?.messages ?? [])).toEqual([
        "Start",
        "One more thing",
      ]);
      const job = await s.storage.jobs.load(s.identity, "chat", "one");
      expect(job?.status).toBe("completed");
      expect(job?.steering).toMatchObject([{ id: "m1", consumed: true }]);
      const next = await s.storage.conversations.load(s.identity, "chat");
      expect(next?.messages.map((turn) => turn.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    });

    it("resends idempotently and rejects reuse with different input", async () => {
      const s = await storageFixture(driver);
      await submit(s);
      await steer(s, "m1", "First");
      const again = await steer(s, "m1", "First");
      expect(again.steering).toHaveLength(1);
      expect(
        again.events.filter((event) => event.type === "steering_received"),
      ).toHaveLength(1);
      await expect(steer(s, "m1", "Other")).rejects.toThrow();
    });

    it("rejects messages for terminal runs and beyond the limit", async () => {
      const s = await storageFixture(driver);
      await submit(s);
      for (let i = 0; i < maxSteering; i++) await steer(s, `m${String(i)}`);
      await expect(steer(s, "extra")).rejects.toThrow();
      await s.storage.jobs.update(
        s.identity,
        "chat",
        "one",
        { type: "completed", text: "x" },
        { status: "completed", text: "x" },
      );
      await expect(steer(s, "late")).rejects.toThrow();
      expect((await steer(s, "m0")).steering).toHaveLength(maxSteering);
    });

    it("does not duplicate or lose a message when the worker dies after the checkpoint", async () => {
      const s = await storageFixture(driver);
      await submit(s);
      await steer(s, "m1", "Change course");
      const provider = createFakeProvider((_request, n) =>
        n === 1 ? call : done,
      );
      let crash = true;
      const storage = {
        ...s.storage,
        jobs: {
          ...s.storage.jobs,
          consumeSteering: (
            ...args: Parameters<typeof s.storage.jobs.consumeSteering>
          ) => {
            if (!crash) return s.storage.jobs.consumeSteering(...args);
            crash = false;
            return Promise.reject(new Error("worker died"));
          },
        },
      };
      const profiles = {
        v1: { provider, tools: [look], system: "Help" },
      };
      const first = createWorker({ storage, profiles, leaseMs: 1000 });
      await first.tick();
      await first.stop();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.steering,
      ).toMatchObject([{ id: "m1", consumed: false }]);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
      const second = createWorker({ storage, profiles, leaseMs: 1000 });
      try {
        await second.tick();
      } finally {
        clock.mockRestore();
        await second.stop();
      }
      const last = provider.requests.at(-1);
      expect(
        userTexts(last?.messages ?? []).filter((t) => t === "Change course"),
      ).toHaveLength(1);
      expect(provider.requests.every((r) => r.messages.length > 0)).toBe(true);
      const job = await s.storage.jobs.load(s.identity, "chat", "one");
      expect(job?.status).toBe("completed");
      expect(job?.steering).toMatchObject([{ id: "m1", consumed: true }]);
      const stored = await s.storage.conversations.load(s.identity, "chat");
      expect(
        userTexts(stored?.messages as never).filter(
          (t) => t === "Change course",
        ),
      ).toHaveLength(1);
    });

    it("queues a message during approval and delivers it after the decision", async () => {
      const s = await storageFixture(driver);
      await submit(s);
      const write = writeTool({
        name: "change",
        description: "Change",
        version: "1",
        input: z.strictObject({}),
        authorize: () => Promise.resolve(true),
        prepare: () => Promise.resolve({ preview: "Change", version: "1" }),
        execute: () => Promise.resolve("receipt"),
        reconcile: () => Promise.resolve(undefined),
      });
      const provider = createFakeProvider((_request, n) =>
        n === 1
          ? {
              content: "",
              toolCalls: [{ id: "w1", name: "change", args: {} }],
              finishReason: "tool_calls",
            }
          : done,
      );
      const worker = createWorker({
        storage: s.storage,
        profiles: { v1: { provider, tools: [write], system: "Help" } },
      });
      await worker.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
      ).toBe("awaiting_approval");
      await steer(s, "m1", "Also this");
      const waiting = await s.storage.jobs.load(s.identity, "chat", "one");
      expect(waiting?.status).toBe("awaiting_approval");
      expect(provider.requests).toHaveLength(1);
      await worker.tick();
      expect(provider.requests).toHaveLength(1);
      const approval = operationId(
        s.identity,
        JSON.stringify(["chat", "one"]),
        "w1",
      );
      await s.storage.actions.decide(s.identity, approval, true);
      await s.storage.jobs.resume(s.identity, "chat", "one", approval);
      await worker.tick();
      await worker.stop();
      expect(userTexts(provider.requests[1]?.messages ?? [])).toEqual([
        "Start",
        "Also this",
      ]);
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
      ).toBe("completed");
    });

    it("serves the endpoint with auth, tenant isolation and conflicts", async () => {
      const s = await storageFixture(driver);
      const other = { actorId: "other", tenantId: s.identity.tenantId };
      const handler = createHandler({
        storage: s.storage,
        origins: [],
        authenticate: (req) =>
          Promise.resolve(
            { mine: s.identity, theirs: other }[
              req.headers.get("authorization") ?? ""
            ],
          ),
        authorizeProfile: () => Promise.resolve(true),
      });
      const request = (token: string, path: string, body: unknown) =>
        handler(
          new Request(`http://localhost/v1/conversations/chat/runs${path}`, {
            method: "POST",
            headers: {
              authorization: token,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        );
      await submit(s);
      const message = { id: "m1", input: "More" };
      expect((await request("none", "/one/messages", message)).status).toBe(
        401,
      );
      expect((await request("theirs", "/one/messages", message)).status).toBe(
        404,
      );
      expect((await request("mine", "/one/messages", { id: "" })).status).toBe(
        400,
      );
      expect(
        (await request("mine", "/one/messages", { id: "x", input: "" })).status,
      ).toBe(400);
      expect((await request("mine", "/one/messages", message)).status).toBe(
        202,
      );
      expect((await request("mine", "/one/messages", message)).status).toBe(
        202,
      );
      expect(
        (await request("mine", "/one/messages", { ...message, input: "No" }))
          .status,
      ).toBe(409);
      expect((await request("mine", "/missing/messages", message)).status).toBe(
        404,
      );
      expect(
        (
          await handler(
            new Request(
              "http://localhost/v1/conversations/chat/runs/one/messages",
              { headers: { authorization: "mine" } },
            ),
          )
        ).status,
      ).toBe(405);
      await s.storage.jobs.update(
        s.identity,
        "chat",
        "one",
        { type: "cancelled" },
        { status: "cancelled" },
      );
      expect(
        (await request("mine", "/one/messages", { id: "m2", input: "Late" }))
          .status,
      ).toBe(409);
    });

    it("sends steering messages from the client with a stable id", async () => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("{}", { status: 503 }))
        .mockResolvedValueOnce(
          Response.json({ accepted: true }, { status: 202 }),
        );
      const client = new BrowserClient({
        baseUrl: "https://host.test",
        fetch: transport,
        reconnectDelayMs: 0,
      });
      await client.steer("chat", "one", "More", "m1");
      expect(transport.mock.calls.map((c) => [c[0], c[1]?.body])).toEqual([
        [
          "https://host.test/v1/conversations/chat/runs/one/messages",
          JSON.stringify({ id: "m1", input: "More" }),
        ],
        [
          "https://host.test/v1/conversations/chat/runs/one/messages",
          JSON.stringify({ id: "m1", input: "More" }),
        ],
      ]);
    });
  });
