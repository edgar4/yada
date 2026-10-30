import { expect, it, vi } from "vitest";
import { once } from "node:events";
import { request } from "node:http";
import { createNodeServer } from "../src/service/node.js";

it("survives forbidden Fetch methods and synchronous handler failures", async () => {
  const handler = vi.fn((request: Request) => {
    if (request.url.endsWith("/error"))
      throw new Error("private-handler-detail");
    return Promise.resolve(new Response("healthy"));
  });
  const server = createNodeServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const trace = request(origin, { method: "TRACE" }, (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode);
        });
      });
      trace.on("error", reject);
      trace.end();
    });
    expect(status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    const failure = await fetch(`${origin}/error`);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("private");
    expect(await (await fetch(origin)).text()).toBe("healthy");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
