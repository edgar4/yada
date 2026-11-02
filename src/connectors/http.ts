import { z } from "zod";
import { readTool } from "../core/tool.js";
import { abortable } from "../core/abort.js";
import type { Identity } from "../core/contracts.js";

type Headers_ = Readonly<Record<string, string>>;
const placeholder = /\{([A-Za-z_]\w*)\}/g;

export function httpReadTool<S extends z.ZodType>(options: {
  name: string;
  description: string;
  input: S;
  origin: string;
  path: string;
  parameters: (
    args: z.output<S>,
  ) => Readonly<Record<string, string | undefined>>;
  pathParameters?: (args: z.output<S>) => Readonly<Record<string, string>>;
  authorize: (identity: Identity) => Promise<boolean>;
  headers?: Headers_ | ((identity: Identity) => Headers_ | Promise<Headers_>);
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
  const placeholders = [...options.path.matchAll(placeholder)].map(
    (match) => match[1] ?? "",
  );
  const fixed = options.path.replace(placeholder, "x");
  const url = new URL(fixed, origin);
  if (
    url.origin !== origin.origin ||
    url.hash ||
    url.search ||
    /[{}]/.test(fixed) ||
    !options.path.startsWith("/") ||
    (placeholders.length > 0 && !options.pathParameters)
  )
    throw new Error("Invalid HTTP path");
  const maxBytes = z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .parse(options.maxBytes ?? 32_000);
  const headerSource = options.headers;
  return readTool({
    ...options,
    async execute(args, identity, signal) {
      if (!(await abortable(() => options.authorize(identity), signal)))
        throw new Error("HTTP access denied");
      const values = options.pathParameters?.(args) ?? {};
      if (
        Object.keys(values).sort().join() !== [...placeholders].sort().join() ||
        Object.values(values).some(
          (value) => value === "" || value === "." || value === "..",
        )
      )
        throw new Error("Invalid HTTP path parameters");
      const target = new URL(
        options.path.replace(placeholder, (_, key: string) =>
          encodeURIComponent(values[key] ?? ""),
        ),
        origin,
      );
      if (target.origin !== origin.origin)
        throw new Error("Invalid HTTP path parameters");
      for (const [key, value] of Object.entries(options.parameters(args)))
        if (value !== undefined) target.searchParams.set(key, value);
      const response = await fetch(target, {
        method: "GET",
        headers: new Headers(
          typeof headerSource === "function"
            ? await abortable(async () => headerSource(identity), signal)
            : headerSource,
        ),
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
            in: z.enum(["query", "path"]),
            name: z.string(),
          }),
        )
        .default([]),
    })
    .parse(spec.paths[options.path]?.["get"]);
  const named = (location: string) =>
    operation.parameters
      .filter((parameter) => parameter.in === location)
      .map((parameter) => parameter.name);
  const templated = [...options.path.matchAll(placeholder)].map(
    (match) => match[1],
  );
  if (
    operation.operationId !== options.operationId ||
    named("path").sort().join() !== templated.sort().join()
  )
    throw new Error("OpenAPI operation mismatch");
  const parameters = new Set(named("query"));
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
