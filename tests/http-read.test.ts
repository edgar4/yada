import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { httpReadTool, reviewedOpenApiGet } from "../src/connectors/http.js";
const identity = { actorId: "a", tenantId: "t" };
const signal = () => AbortSignal.timeout(5000);
afterEach(() => {
  vi.unstubAllGlobals();
});
const httpOptions = {
  name: "lookup",
  description: "Lookup",
  input: z.strictObject({ id: z.string() }),
  origin: "https://example.test",
  path: "/items",
  parameters: (args: { id: string }) => ({ id: args.id }),
  authorize: vi.fn(() => Promise.resolve(true)),
};
it("constrains GET destinations, headers, parameters and authorization", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response('{"ok":true}')));
  vi.stubGlobal("fetch", fetchMock);
  const tool = httpReadTool({
    ...httpOptions,
    headers: { authorization: "Bearer secret" },
  });
  expect(await tool.execute({ id: "../?a&b=1" }, identity, signal())).toBe(
    '{"ok":true}',
  );
  const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.href).toBe("https://example.test/items?id=..%2F%3Fa%26b%3D1");
  expect(init).toMatchObject({ method: "GET", redirect: "error" });
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
  await expect(tool.execute({ id: 1 }, identity, signal())).rejects.toThrow();
  await expect(
    tool.execute({ id: "a" }, identity, AbortSignal.abort()),
  ).rejects.toThrow();
  await expect(
    httpReadTool({
      ...httpOptions,
      authorize: () => Promise.resolve(false),
    }).execute({ id: "a" }, identity, signal()),
  ).rejects.toThrow("denied");
  expect(fetchMock).toHaveBeenCalledOnce();
});
it.each([
  { origin: "file:///tmp" },
  { origin: "https://u:p@example.test" },
  { origin: "https://example.test/a" },
  { path: "//other.test/a" },
  { path: "/a?x=1" },
  { path: "/a#x" },
  { path: "a" },
  { maxBytes: 0 },
])("rejects unsafe HTTP configuration %j", (change) => {
  expect(() => httpReadTool({ ...httpOptions, ...change })).toThrow();
});
it("bounds streamed bytes, rejects errors and malformed UTF-8, and permits empty bodies", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("secret", { status: 500 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response("éé"))
    .mockResolvedValueOnce(new Response(new Uint8Array([255])));
  vi.stubGlobal("fetch", fetchMock);
  const tool = httpReadTool({ ...httpOptions, maxBytes: 3 });
  await expect(tool.execute({ id: "a" }, identity, signal())).rejects.toThrow(
    "HTTP read failed",
  );
  expect(await tool.execute({ id: "a" }, identity, signal())).toBe("");
  await expect(tool.execute({ id: "a" }, identity, signal())).rejects.toThrow(
    "too large",
  );
  await expect(tool.execute({ id: "a" }, identity, signal())).rejects.toThrow();
});
it("requires an explicitly reviewed OpenAPI GET operation and query mapping", async () => {
  const document = {
    openapi: "3.1.0",
    paths: {
      "/items": {
        get: { operationId: "list", parameters: [{ in: "query", name: "id" }] },
      },
    },
  };
  const options = { ...httpOptions, operationId: "list" };
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("ok"))),
  );
  expect(
    await reviewedOpenApiGet(document, options).execute(
      { id: "a" },
      identity,
      signal(),
    ),
  ).toBe("ok");
  expect(() =>
    reviewedOpenApiGet(document, { ...options, operationId: "delete" }),
  ).toThrow("mismatch");
  expect(() =>
    reviewedOpenApiGet(
      { ...document, paths: { "/items": { post: { operationId: "list" } } } },
      options,
    ),
  ).toThrow();
  expect(() =>
    reviewedOpenApiGet(
      { ...document, paths: { "/{id}": { get: { operationId: "list" } } } },
      { ...options, path: "/{id}" },
    ),
  ).toThrow("mismatch");
  await expect(
    reviewedOpenApiGet(
      { ...document, paths: { "/items": { get: { operationId: "list" } } } },
      options,
    ).execute({ id: "a" }, identity, signal()),
  ).rejects.toThrow("Unreviewed");
});
