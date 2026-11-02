import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
export type NodeServerOptions = Readonly<{
  maxConnections?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  onError?: (error: unknown, request?: Request) => void;
}>;
export function createNodeServer(
  handler: (request: Request) => Promise<Response>,
  options: NodeServerOptions = {},
) {
  const server = createServer((incoming, outgoing) => {
    let request: Request | undefined;
    const controller = new AbortController();
    outgoing.on("close", () => {
      controller.abort();
    });
    void Promise.resolve()
      .then(() => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value))
            for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const init: RequestInit & { duplex: "half" } = {
          method: incoming.method ?? "GET",
          headers,
          signal: controller.signal,
          duplex: "half",
        };
        if (incoming.method !== "GET" && incoming.method !== "HEAD")
          init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        request = new Request(
          new URL(incoming.url ?? "/", "http://localhost"),
          init,
        );
        return handler(request);
      })
      .then(async (response) => {
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        if (!response.body) {
          outgoing.end();
          return;
        }
        for await (const chunk of Readable.fromWeb(
          response.body as NodeReadableStream<Uint8Array>,
        )) {
          if (controller.signal.aborted) break;
          if (!outgoing.write(chunk))
            await new Promise<void>((resolve) => {
              outgoing.once("drain", resolve);
              outgoing.once("close", resolve);
            });
        }
        outgoing.end();
      })
      .catch((error: unknown) => {
        try {
          options.onError?.(error, request);
        } catch {
          void 0;
        }
        if (!outgoing.headersSent) outgoing.writeHead(503);
        outgoing.end();
      });
  });
  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  server.headersTimeout = options.headersTimeoutMs ?? 15_000;
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 65_000;
  if (options.maxConnections) server.maxConnections = options.maxConnections;
  return server;
}
export function closeNodeServer(server: Server, graceMs = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, graceMs);
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
