import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectMcp } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
it("negotiates HTTP MCP and executes a discovered tool", async () => {
  const methods: string[] = [];
  const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET")
      return Promise.resolve(new Response("", { status: 405 }));
    const request = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.unknown().optional(),
      })
      .parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    methods.push(request.method);
    if (request.id === undefined)
      return Promise.resolve(new Response(null, { status: 202 }));
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "test", version: "1" },
          }
        : request.method === "tools/list"
          ? {
              tools: [
                {
                  name: "lookup",
                  inputSchema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                  },
                },
              ],
            }
          : {
              content: [
                { type: "text", text: "Found" },
                { type: "text", text: "a" },
              ],
            };
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const identity = { actorId: "a", tenantId: "t" };
  const c = await connectMcp(
    { name: "catalog", url: "https://example.test/mcp", readTools: ["lookup"] },
    { identity, authorize: () => Promise.resolve(true) },
  );
  try {
    expect(
      await c.tools[0]?.execute(
        { id: "a" },
        identity,
        AbortSignal.timeout(1000),
      ),
    ).toBe("Found\na");
    expect(methods).toEqual(
      expect.arrayContaining([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ]),
    );
  } finally {
    await c.close();
  }
});
it.each(["file:///tmp/mcp", "https://user:secret@example.test/mcp"])(
  "rejects invalid MCP URLs %s",
  async (url) => {
    await expect(
      connectMcp(
        { name: "catalog", url, readTools: ["lookup"] },
        {
          identity: { actorId: "a", tenantId: "t" },
          authorize: () => Promise.resolve(true),
        },
      ),
    ).rejects.toThrow();
  },
);
