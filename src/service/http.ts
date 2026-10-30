import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import type { YadaStorage } from "../storage/index.js";
import { JobConflict } from "../storage/jobs.js";
import { isTerminal, jobInputSchema } from "./contracts.js";
export async function readJson(
  request: Request,
  maximum = 65_536,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) throw new RangeError("Request too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export function createHandler(options: {
  storage: YadaStorage;
  origins: readonly string[];
  authenticate: (request: Request) => Promise<Identity | undefined>;
  authorizeProfile: (identity: Identity, profileId: string) => Promise<boolean>;
}) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      vary: "Origin",
    });
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers });
    if (origin && !options.origins.includes(origin))
      return json({ error: "Origin denied" }, 403);
    if (origin) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-credentials", "true");
    }
    if (request.method === "OPTIONS") {
      headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
      headers.set(
        "access-control-allow-headers",
        "Content-Type, Authorization",
      );
      return new Response(null, { status: 204, headers });
    }
    try {
      const identity = await options.authenticate(request);
      if (!identity) return json({ error: "Authentication required" }, 401);
      const url = new URL(request.url);
      const match =
        /^\/v1\/conversations\/([^/]+)\/runs(?:\/([^/]+)(?:\/(events|cancel|approvals\/[^/]+(?:\/decision)?))?)?$/.exec(
          url.pathname,
        );
      if (!match?.[1]) return json({ error: "Not found" }, 404);
      const conversationId = decodeURIComponent(match[1]);
      const id = match[2] ? decodeURIComponent(match[2]) : undefined;
      if (!id && request.method === "POST") {
        const input = jobInputSchema.parse(await readJson(request));
        if (!(await options.authorizeProfile(identity, input.profileId)))
          return json({ error: "Profile denied" }, 403);
        return json(
          await options.storage.jobs.submit(identity, conversationId, input),
          202,
        );
      }
      if (!id) return json({ error: "Method not allowed" }, 405);
      const job = await options.storage.jobs.load(identity, conversationId, id);
      if (!job) return json({ error: "Not found" }, 404);
      if (match[3]?.startsWith("approvals/")) {
        const approvalId = match[3].split("/")[1] ?? "";
        const action = await options.storage.actions.load(identity, approvalId);
        if (action?.runId !== JSON.stringify([conversationId, id]))
          return json({ error: "Not found" }, 404);
        if (request.method === "GET")
          return json({
            id: action.id,
            preview: action.preview,
            status: action.status,
            expiresAt: action.expiresAt,
          });
        if (request.method !== "POST" || !match[3].endsWith("/decision"))
          return json({ error: "Method not allowed" }, 405);
        const decision = z
          .strictObject({ approved: z.boolean() })
          .parse(await readJson(request));
        await options.storage.actions.decide(
          identity,
          approvalId,
          decision.approved,
        );
        await options.storage.jobs.update(identity, conversationId, id, {
          type: "queued",
        });
        return json({ accepted: true }, 202);
      }
      if (match[3] === "cancel" && request.method === "POST") {
        await options.storage.jobs.cancel(identity, conversationId, id);
        return json({ accepted: true }, 202);
      }
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405);
      if (!match[3]) return json(job);
      if (match[3] !== "events") return json({ error: "Not found" }, 404);
      let cursor = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(url.searchParams.get("after") ?? 0);
      if (cursor > job.events.length)
        return json({ error: "Invalid event cursor" }, 409);
      const stopped = new AbortController();
      const signal = AbortSignal.any([request.signal, stopped.signal]);
      const encoder = new TextEncoder();
      headers.set("content-type", "application/x-ndjson; charset=utf-8");
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              for (;;) {
                signal.throwIfAborted();
                const currentIdentity = await options.authenticate(request);
                if (
                  currentIdentity?.actorId !== identity.actorId ||
                  currentIdentity.tenantId !== identity.tenantId
                )
                  throw new Error("Access revoked");
                const current = await options.storage.jobs.load(
                  identity,
                  conversationId,
                  id,
                );
                if (!current) throw new Error("Run removed");
                const events = current.events.filter(
                  (event) => event.sequence > cursor,
                );
                for (const event of events) {
                  controller.enqueue(
                    encoder.encode(JSON.stringify(event) + "\n"),
                  );
                  cursor = event.sequence;
                }
                if (isTerminal(current.status)) {
                  controller.close();
                  return;
                }
                if (events.length) return;
                await delay(100, undefined, { signal });
              }
            } catch {
              controller.error(new Error("Event stream disconnected"));
            }
          },
          cancel() {
            stopped.abort();
          },
        }),
        { headers },
      );
    } catch (error) {
      if (error instanceof JobConflict)
        return json({ error: error.message }, 409);
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof URIError
      )
        return json({ error: "Invalid request" }, 400);
      if (error instanceof RangeError)
        return json({ error: "Request too large" }, 413);
      return json({ error: "Request failed" }, 503);
    }
  };
}
