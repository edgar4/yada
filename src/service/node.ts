import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
export function createNodeServer(
  handler: (request: Request) => Promise<Response>,
) {
  return createServer((incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.on("close", () => {
      controller.abort();
    });
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
    const request = new Request(
      new URL(incoming.url ?? "/", "http://localhost"),
      init,
    );
    void handler(request)
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
      .catch(() => {
        if (!outgoing.headersSent) outgoing.writeHead(503);
        outgoing.end();
      });
  });
}
