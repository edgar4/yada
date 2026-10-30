import { z } from "zod";
import { readTool } from "../core/tool.js";
import { abortable } from "../core/abort.js";
import type { Identity } from "../core/contracts.js";

export function httpReadTool<S extends z.ZodType>(options: {
  name: string;
  description: string;
  input: S;
  origin: string;
  path: string;
  parameters: (args: z.output<S>) => Readonly<Record<string, string>>;
  authorize: (identity: Identity) => Promise<boolean>;
  headers?: Readonly<Record<string, string>>;
  maxBytes?: number;
}) {
  const origin = new URL(options.origin);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("Invalid HTTP origin");
  const url = new URL(options.path, origin);
  if (
    url.origin !== origin.origin ||
    url.hash ||
    url.search ||
    !options.path.startsWith("/")
  )
    throw new Error("Invalid HTTP path");
  const maxBytes = z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .parse(options.maxBytes ?? 32_000);
  const headers = new Headers(options.headers);
  return readTool({
    ...options,
    async execute(args, identity, signal) {
      if (!(await abortable(() => options.authorize(identity), signal)))
        throw new Error("HTTP access denied");
      const target = new URL(url);
      for (const [key, value] of Object.entries(options.parameters(args)))
        target.searchParams.set(key, value);
      const response = await fetch(target, {
        method: "GET",
        headers,
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("HTTP read failed");
      const body = response.body as ReadableStream<Uint8Array> | null;
      if (!body) return "";
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await abortable(() => reader.read(), signal);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBytes) throw new Error("HTTP result too large");
          chunks.push(next.value);
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  });
}

export function reviewedOpenApiGet<S extends z.ZodType>(
  document: unknown,
  options: Parameters<typeof httpReadTool<S>>[0] & { operationId: string },
) {
  const spec = z
    .object({
      openapi: z.string().regex(/^3\./),
      paths: z.record(z.string(), z.record(z.string(), z.unknown())),
    })
    .parse(document);
  const operation = z
    .object({
      operationId: z.string(),
      parameters: z
        .array(
          z.object({
            in: z.literal("query"),
            name: z.string(),
          }),
        )
        .default([]),
    })
    .parse(spec.paths[options.path]?.["get"]);
  if (
    operation.operationId !== options.operationId ||
    options.path.includes("{")
  )
    throw new Error("OpenAPI operation mismatch");
  const parameters = new Set(
    operation.parameters.map((parameter) => parameter.name),
  );
  return httpReadTool({
    ...options,
    parameters(args) {
      const values = options.parameters(args);
      if (Object.keys(values).some((key) => !parameters.has(key)))
        throw new Error("Unreviewed OpenAPI parameter");
      return values;
    },
  });
}
