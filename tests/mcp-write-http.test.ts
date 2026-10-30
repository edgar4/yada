import { expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connectMcp, type McpConnection, type Tool } from "../src/index.js";
import {
  mutation,
  owner,
  protocolServer,
  writeConfig,
} from "./helpers/mcp-protocol.js";

it("serializes prepare, approved execution and receipt context through a real HTTP MCP server", async () => {
  const fixture = protocolServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await fixture.server.connect(transport);
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer fixture-secret") {
      response.writeHead(401);
      response.end();
      return;
    }
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  let connection: McpConnection<Tool> | undefined;
  try {
    connection = await connectMcp(
      {
        ...writeConfig,
        url: `http://127.0.0.1:${String(address.port)}/mcp`,
        token: "fixture-secret",
      },
      { identity: owner, authorize: fixture.authorize },
    );
    fixture.calls
      .mockResolvedValueOnce({
        content: [],
        structuredContent: { preview: "Change Åda", version: "state-1" },
      })
      .mockResolvedValueOnce({
        content: [],
        structuredContent: { status: "completed", receipt: "http-receipt" },
      })
      .mockResolvedValueOnce({
        content: [],
        structuredContent: { status: "completed", receipt: "http-receipt" },
      });
    const tool = mutation(connection);
    const signal = AbortSignal.timeout(3000);
    const prepared = await tool.prepare({ value: "Åda" }, owner, signal);
    expect(prepared).toEqual({ preview: "Change Åda", version: "state-1" });
    expect(
      await tool.execute(
        { value: "Åda" },
        {
          identity: owner,
          signal,
          operationId: "approved-operation",
          version: prepared.version,
        },
      ),
    ).toBe("http-receipt");
    expect(await tool.reconcile("approved-operation", owner, signal)).toBe(
      "http-receipt",
    );
    const requests = fixture.calls.mock.calls.map(([request]) => request);
    expect(
      requests.map((request) => [request.name, request.arguments]),
    ).toEqual([
      ["preview", { arguments: { value: "Åda" } }],
      ["change", { value: "Åda" }],
      ["receipt", {}],
    ]);
    expect(
      requests.map((request) => request._meta?.["io.yada/action"]),
    ).toEqual([
      {
        contractVersion: 1,
        tool: "change",
        actorId: owner.actorId,
        tenantId: owner.tenantId,
      },
      {
        contractVersion: 1,
        tool: "change",
        actorId: owner.actorId,
        tenantId: owner.tenantId,
        operationId: "approved-operation",
        version: "state-1",
      },
      {
        contractVersion: 1,
        tool: "change",
        actorId: owner.actorId,
        tenantId: owner.tenantId,
        operationId: "approved-operation",
      },
    ]);
  } finally {
    await connection?.close();
    await fixture.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
