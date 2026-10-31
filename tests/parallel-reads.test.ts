import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakeProvider, readTool, run, writeTool } from "../src/index.js";
import type { ProviderResult, RunCheckpoint, RunLimits } from "../src/index.js";
const answer: ProviderResult = {
  content: "Done",
  toolCalls: [],
  finishReason: "stop",
};
const batch = (...calls: [string, string][]): ProviderResult => ({
  content: "",
  toolCalls: calls.map(([id, name]) => ({ id, name, args: {} })),
  finishReason: "tool_calls",
});
function setup(
  delays: Record<string, number>,
  extra: { limits?: RunLimits; signal?: AbortSignal } = {},
) {
  const log: string[] = [];
  let active = 0;
  let peak = 0;
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  const read = (name: string) =>
    readTool({
      name,
      description: name,
      input: z.strictObject({}),
      authorize: () => Promise.resolve(true),
      execute: async (_args, _identity, signal) => {
        log.push(`start ${name}`);
        active++;
        peak = Math.max(peak, active);
        try {
          await sleep(delays[name] ?? 5, signal);
          if (name.startsWith("bad")) throw new Error("boom");
          log.push(`end ${name}`);
          return name;
        } finally {
          active--;
        }
      },
    });
  const write = writeTool({
    name: "save",
    description: "Save",
    version: "1",
    input: z.strictObject({}),
    authorize: () => Promise.resolve(true),
    prepare: () => Promise.resolve({ preview: "s", version: "1" }),
    execute: () => Promise.resolve("saved"),
    reconcile: () => Promise.resolve(undefined),
  });
  const names = ["a", "b", "c", "d", "e", "bad"];
  const options = (first: ProviderResult, checkpoint?: RunCheckpoint) => ({
    provider: createFakeProvider((_r, call) => (call === 1 ? first : answer)),
    tools: [...names.map(read), write],
    identity: { actorId: "actor", tenantId: "tenant" },
    input: "go",
    system: "s",
    signal: extra.signal ?? new AbortController().signal,
    executeWrite: (_tool: unknown, call: { id: string }) => {
      log.push(`write ${call.id}`);
      return Promise.resolve("saved");
    },
    ...(extra.limits ? { limits: extra.limits } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  });
  return { log, options, peak: () => peak };
}
const toolContents = (checkpoint: RunCheckpoint) =>
  checkpoint.messages.flatMap((m) => (m.role === "tool" ? [m.content] : []));
describe("parallel reads", () => {
  it("runs reads concurrently up to maxParallelTools and keeps call order", async () => {
    const s = setup({ a: 40, b: 5, c: 20, d: 5, e: 5 });
    let last: RunCheckpoint | undefined;
    const result = await run({
      ...s.options(
        batch(["1", "a"], ["2", "b"], ["3", "c"], ["4", "d"], ["5", "e"]),
      ),
      limits: { maxParallelTools: 2 },
      persist: (c) => {
        last = c;
        return Promise.resolve();
      },
    });
    expect(result.status).toBe("completed");
    expect(s.peak()).toBe(2);
    expect(toolContents(last as RunCheckpoint)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
  it("defaults to four concurrent reads", async () => {
    const s = setup({ a: 20, b: 20, c: 20, d: 20, e: 20 });
    await run(
      s.options(
        batch(["1", "a"], ["2", "b"], ["3", "c"], ["4", "d"], ["5", "e"]),
      ),
    );
    expect(s.peak()).toBe(4);
  });
  it("treats writes as sequential barriers", async () => {
    const s = setup({ a: 30, b: 5, c: 5 });
    await run(
      s.options(batch(["1", "a"], ["2", "b"], ["3", "save"], ["4", "c"])),
    );
    expect(s.log.indexOf("write 3")).toBeGreaterThan(s.log.indexOf("end a"));
    expect(s.log.indexOf("write 3")).toBeGreaterThan(s.log.indexOf("end b"));
    expect(s.log.indexOf("start c")).toBeGreaterThan(s.log.indexOf("write 3"));
  });
  it("keeps other results when one read fails", async () => {
    const s = setup({});
    let last: RunCheckpoint | undefined;
    await run({
      ...s.options(batch(["1", "a"], ["2", "bad"], ["3", "c"])),
      persist: (c) => {
        last = c;
        return Promise.resolve();
      },
    });
    const [first, second, third] = toolContents(last as RunCheckpoint);
    expect(first).toBe("a");
    expect(second).toContain("tool_failed");
    expect(third).toBe("c");
  });
  it("re-runs only reads without a stored result after a crash", async () => {
    const s = setup({ a: 5, b: 60, c: 5 });
    const saves: RunCheckpoint[] = [];
    const crash = new Error("crash");
    await expect(
      run({
        ...s.options(batch(["1", "a"], ["2", "b"], ["3", "c"])),
        persist: (c) => {
          saves.push(c);
          return c.messages.some((m) => m.role === "tool")
            ? Promise.reject(crash)
            : Promise.resolve();
        },
      }),
    ).rejects.toThrow();
    const checkpoint = saves[saves.length - 1] as RunCheckpoint;
    expect(checkpoint.pending.map((c) => c.id)).toEqual(["2", "3"]);
    const resumed = setup({});
    const result = await run(resumed.options(answer, checkpoint));
    expect(result.status).toBe("completed");
    expect(resumed.log.filter((l) => l.startsWith("start"))).toEqual([
      "start b",
      "start c",
    ]);
  });
  it("aborts in-flight reads on cancellation", async () => {
    const controller = new AbortController();
    const s = setup({ a: 1000, b: 1000 }, { signal: controller.signal });
    const pending = run(s.options(batch(["1", "a"], ["2", "b"])));
    setTimeout(() => {
      controller.abort();
    }, 20);
    expect(await pending).toEqual({ status: "cancelled" });
    expect(s.log).not.toContain("end a");
  });
});
