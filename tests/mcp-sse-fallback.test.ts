import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { connectMcp } from "../src/index.js";

let http: Server | undefined;
afterEach(() => {
  http?.closeAllConnections();
  http?.close();
});

async function legacyServer(postStatus: number) {
  const mcp = new McpServer({ name: "legacy", version: "1" });
  mcp.registerTool(
    "lookup",
    {
      description: "Lookup",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => ({ content: [{ type: "text", text: `found ${id}` }] }),
  );
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- fixture for a legacy SSE server
  let transport: SSEServerTransport | undefined;
  http = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/mcp") {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- fixture for a legacy SSE server
      transport = new SSEServerTransport("/messages", res);
      void mcp.connect(transport);
    } else if (req.method === "POST" && req.url?.startsWith("/messages"))
      void transport?.handlePostMessage(req, res);
    else res.writeHead(postStatus).end();
  });
  await new Promise<void>((resolve) => http?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/mcp`;
}

const identity = { actorId: "a", tenantId: "t" };
const access = { identity, authorize: () => Promise.resolve(true) };

it("falls back to legacy SSE when Streamable HTTP is unsupported", async () => {
  const url = await legacyServer(405);
  const c = await connectMcp({ name: "legacy", url }, access);
  try {
    expect(
      await c.tools[0]?.execute(
        { id: "a" },
        identity,
        AbortSignal.timeout(2000),
      ),
    ).toBe("found a");
  } finally {
    await c.close();
  }
});

it("does not fall back on authorization failures", async () => {
  const url = await legacyServer(401);
  await expect(connectMcp({ name: "legacy", url }, access)).rejects.toThrow();
});
