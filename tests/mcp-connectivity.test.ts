import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { connectMcp, mcpServersFromEnv } from "../src/index.js";
import { contentText } from "../src/core/content.js";
import type { McpConnection } from "../src/index.js";

const identity = { actorId: "a", tenantId: "t" };
const access = { identity, authorize: () => Promise.resolve(true) };
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.unstubAllGlobals();
});
async function local(extra: Record<string, unknown> = {}) {
  const connection: McpConnection = await connectMcp(
    {
      name: "local",
      command: process.execPath,
      args: ["--import", tsx, `${process.cwd()}/tests/fixtures/mcp-server.ts`],
      ...extra,
    },
    access,
    AbortSignal.timeout(10_000),
  );
  cleanups.push(connection.close);
  return async (name: string) => {
    const tool = connection.tools.find((t) => t.spec.name === `local__${name}`);
    if (!tool) throw new Error("missing tool");
    return contentText(
      await tool.execute({}, identity, AbortSignal.timeout(10_000)),
    );
  };
}
it("passes env and cwd to stdio servers", async () => {
  const dir = realpathSync(tmpdir());
  const call = await local({ env: { YADA_TEST: "yes" }, cwd: dir });
  expect(JSON.parse(await call("context"))).toEqual({ env: "yes", cwd: dir });
});
it("returns tool errors to the model", async () => {
  const call = await local();
  expect(JSON.parse(await call("fail"))).toEqual({
    error: "tool_failed",
    message: "boom",
  });
});
it("renders non-text content as placeholders", async () => {
  const call = await local();
  expect(await call("mixed")).toBe(
    "a\n[image: image/png]\n[audio: audio/wav]\n[resource: file:///x]\n[resource_link: file:///y why]",
  );
});
it("applies the per-server call timeout", async () => {
  const call = await local({ timeoutMs: 1000 });
  await expect(call("slow")).rejects.toThrow("MCP request failed");
});
it("sends custom headers over HTTP", async () => {
  const seen: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response("", { status: 500 }));
    }),
  );
  await connectMcp(
    {
      name: "h",
      url: "https://example.test/mcp",
      headers: { "x-api-key": "k" },
    },
    access,
  ).catch(() => undefined);
  expect(seen[0]?.get("x-api-key")).toBe("k");
});
it("rejects authorization headers alongside a token", () => {
  expect(() =>
    mcpServersFromEnv({
      YADA_MCP_SERVERS: JSON.stringify([
        {
          name: "a",
          url: "https://example.test/mcp",
          token: "t",
          headers: { Authorization: "x" },
        },
      ]),
    }),
  ).toThrow("Invalid YADA_MCP_SERVERS configuration");
});
it("loads the new fields from the environment and validates limits", () => {
  const raw = (server: object) =>
    mcpServersFromEnv({ YADA_MCP_SERVERS: JSON.stringify([server]) });
  expect(
    raw({
      name: "a".repeat(32),
      command: "x",
      env: { A: "b" },
      cwd: "/",
      stderr: "inherit",
      timeoutMs: 5000,
    }),
  ).toHaveLength(1);
  expect(() => raw({ name: "a".repeat(33), command: "x" })).toThrow();
  expect(() => raw({ name: "a", command: "x", timeoutMs: 999 })).toThrow();
  expect(() => raw({ name: "a", command: "x", stderr: "pipe" })).toThrow();
});
