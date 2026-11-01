import { expect, it, vi } from "vitest";
import { z } from "zod";
import { storageFixture } from "./helpers/storage.js";
import {
  createEventBus,
  createFakeProvider,
  createHandler,
  createWorker,
  readTool,
  run,
  type AgentEvent,
  type ProviderResult,
} from "../src/index.js";
import { eventSchema } from "../src/service/contracts.js";
const lookup = readTool({
  name: "lookup",
  description: "Lookup",
  input: z.strictObject({ secret: z.string() }),
  authorize: () => Promise.resolve(true),
  execute: () => Promise.resolve("private result"),
});
const script = (_: unknown, call: number): ProviderResult =>
  call === 1
    ? {
        content: "",
        toolCalls: [{ id: "c1", name: "lookup", args: { secret: "s3cret" } }],
        finishReason: "tool_calls",
        usage: { inputTokens: 3, outputTokens: 2 },
      }
    : {
        content: "Hello there",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 4 },
      };
const identity = { actorId: "a", tenantId: "t" };
const options = (
  provider = createFakeProvider(script, ["Hello ", "there"]),
) => ({
  provider,
  tools: [lookup],
  identity,
  input: "Hi",
  system: "Help",
  signal: AbortSignal.timeout(3000),
});
it("emits text deltas in order and returns the same result as non-streaming", async () => {
  const events: AgentEvent[] = [];
  const streamed = await run({
    ...options(),
    hooks: {
      onEvent: (event) => {
        events.push(event);
        return undefined;
      },
    },
  });
  const plain = await run(options(createFakeProvider(script)));
  expect(streamed).toEqual(plain);
  const types = events.map((event) => event.type);
  expect(types.slice(0, 4)).toEqual([
    "round_started",
    "text_delta",
    "text_delta",
    "model_finished",
  ]);
  expect(types.indexOf("tool_started")).toBeLessThan(
    types.lastIndexOf("text_delta"),
  );
  expect(types.at(-1)).toBe("run_finished");
  const provider = createFakeProvider(script, ["x"]);
  const stream = vi.spyOn(provider, "stream");
  await run(options(provider));
  expect(stream).not.toHaveBeenCalled();
});
it("keeps cancellation working mid-stream", async () => {
  const controller = new AbortController();
  const provider = createFakeProvider(script, ["a", "b"]);
  const result = await run({
    ...options(provider),
    signal: controller.signal,
    hooks: {
      onEvent: (event) => {
        if (event.type === "text_delta") controller.abort();
        return undefined;
      },
    },
  });
  expect(result).toEqual({ status: "cancelled" });
});
async function service(bus?: ReturnType<typeof createEventBus>) {
  const s = await storageFixture("sqlite");
  const authenticate = vi.fn(() => Promise.resolve(s.identity));
  const provider = createFakeProvider(script, ["Hello ", "there"]);
  const stream = vi.spyOn(provider, "stream");
  const worker = createWorker({
    storage: s.storage,
    ...(bus ? { bus } : {}),
    profiles: { v1: { provider, tools: [lookup], system: "Help" } },
  });
  const handler = createHandler({
    storage: s.storage,
    origins: [],
    authenticate,
    authorizeProfile: () => Promise.resolve(true),
    ...(bus ? { bus } : {}),
  });
  const call = (path: string, init?: RequestInit) =>
    handler(
      new Request(`http://localhost/v1/conversations/chat/runs${path}`, init),
    );
  await call("", {
    method: "POST",
    body: JSON.stringify({ id: "a", input: "Hi", profileId: "v1" }),
  });
  const read = async (response: Response) =>
    z.array(eventSchema).parse(
      (await response.text())
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line)),
    );
  return { ...s, worker, call, read, authenticate, stream };
}
it("merges live deltas with persisted tool and usage events in order", async () => {
  const s = await service(createEventBus());
  const live = s.call("/a/events");
  await s.worker.tick();
  const events = await s.read(await live);
  const types = events.map((event) => event.type);
  const first = types.indexOf("text_delta");
  expect(first).toBeGreaterThan(-1);
  expect(first).toBeLessThan(types.indexOf("tool_started"));
  expect(types.indexOf("tool_started")).toBeLessThan(
    types.indexOf("tool_finished"),
  );
  expect(types.indexOf("tool_finished")).toBeLessThan(
    types.lastIndexOf("text_delta"),
  );
  expect(types.at(-1)).toBe("completed");
  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.text)
    .join("");
  expect(text).toBe("Hello thereHello there");
  const persisted = events.filter((event) => event.type !== "text_delta");
  expect(persisted.map((event) => event.sequence)).toEqual(
    persisted.map((_, index) => index + 1),
  );
  const job = await s.storage.jobs.load(s.identity, "chat", "a");
  expect(job?.events.some((event) => event.type === "text_delta")).toBe(false);
  expect(job?.events.filter((event) => event.type === "usage")).toMatchObject([
    { inputTokens: 3, outputTokens: 2 },
    { inputTokens: 5, outputTokens: 4 },
  ]);
  expect(
    job?.events.find((event) => event.type === "tool_started"),
  ).toMatchObject({
    tool: "lookup",
  });
  expect(JSON.stringify(job?.events)).not.toMatch(/s3cret|private result/);
});
it("resumes from a cursor with persisted events only", async () => {
  const s = await service(createEventBus());
  await s.worker.tick();
  const all = await s.read(await s.call("/a/events"));
  expect(all.every((event) => event.type !== "text_delta")).toBe(true);
  const tail = await s.read(await s.call("/a/events?after=2"));
  expect(tail.map((event) => event.sequence)).toEqual(
    all.slice(2).map((event) => event.sequence),
  );
});
it("behaves as before without a shared bus", async () => {
  const s = await service();
  const live = s.call("/a/events");
  await s.worker.tick();
  const events = await s.read(await live);
  expect(events.some((event) => event.type === "text_delta")).toBe(false);
  expect(events.some((event) => event.type === "tool_started")).toBe(true);
  expect(events.at(-1)?.type).toBe("completed");
  expect(s.stream).not.toHaveBeenCalled();
});
it("re-authenticates a waiting stream at most every five seconds", async () => {
  const s = await service(createEventBus());
  const controller = new AbortController();
  const response = await s.call("/a/events", { signal: controller.signal });
  const reader = response.body?.getReader();
  await reader?.read();
  const pending = reader?.read().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  controller.abort();
  await pending;
  expect(s.authenticate.mock.calls.length).toBeLessThanOrEqual(3);
});
it("records parallel read calls in call order and keeps profile hooks", async () => {
  const s = await storageFixture("sqlite");
  const seen: string[] = [];
  const slow = (name: string, ms: number) =>
    readTool({
      name,
      description: name,
      input: z.strictObject({}),
      authorize: () => Promise.resolve(true),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return name;
      },
    });
  const worker = createWorker({
    storage: s.storage,
    profiles: {
      v1: {
        provider: createFakeProvider((_, call) =>
          call === 1
            ? {
                content: "",
                toolCalls: [
                  { id: "1", name: "slow", args: {} },
                  { id: "2", name: "fast", args: {} },
                ],
                finishReason: "tool_calls",
              }
            : { content: "ok", toolCalls: [], finishReason: "stop" },
        ),
        tools: [slow("slow", 60), slow("fast", 1)],
        system: "Help",
        hooks: {
          onEvent: (event) => {
            seen.push(event.type);
            return undefined;
          },
        },
      },
    },
  });
  await s.storage.jobs.submit(s.identity, "chat", {
    id: "p",
    input: "Hi",
    profileId: "v1",
  });
  await worker.tick();
  const job = await s.storage.jobs.load(s.identity, "chat", "p");
  expect(
    job?.events
      .filter((event) => event.tool)
      .map((event) => `${event.type}:${event.tool ?? ""}`),
  ).toEqual([
    "tool_started:slow",
    "tool_started:fast",
    "tool_finished:slow",
    "tool_finished:fast",
  ]);
  expect(seen).toContain("run_finished");
});
