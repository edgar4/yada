import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import type { YadaStorage } from "../storage/index.js";
import { elicitationTool, validElicitation } from "../core/action.js";
import { ActionConflict } from "../storage/actions.js";
import { JobConflict } from "../storage/jobs.js";
import { contentText } from "../core/content.js";
import type { ConversationMessage } from "../storage/conversations.js";
import {
  HttpError,
  isTerminal,
  jobInputSchema,
  maxJobBodyBytes,
  steeringInputSchema,
  type Job,
  type RunEvent,
} from "./contracts.js";
import { admitRun, settleRun, type QuotaOptions } from "./quota.js";
import { eventKey, type EventBus } from "./events.js";
import { resumeDecided } from "./recovery.js";
export async function readJson(
  request: Request,
  maximum = 65_536,
): Promise<unknown> {
  if (
    !/^application\/json\s*(;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new HttpError(415, "Content-Type must be application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Missing body");
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
const visibleMessages = (
  messages: readonly ConversationMessage[],
): { role: string; content?: string; code?: string }[] =>
  messages.flatMap(
    (message): { role: string; content?: string; code?: string }[] =>
      message.role === "failure"
        ? [message]
        : (message.role === "user" ||
              (message.role === "assistant" && !message.toolCalls.length)) &&
            contentText(message.content)
          ? [{ role: message.role, content: contentText(message.content) }]
          : [],
  );
const LEASE_TTL_MS = 30_000;
const parseRequest = <T>(schema: z.ZodType<T>, value: unknown) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid request");
  return parsed.data;
};
export type HandlerLimits = Readonly<{
  requestsPerMinute?: number;
  streamsPerActor?: number;
}>;
export type RememberScope = "run" | "conversation";

export function createHandler(options: {
  storage: YadaStorage;
  origins: readonly string[];
  authenticate: (request: Request) => Promise<Identity | undefined>;
  authorizeProfile: (identity: Identity, profileId: string) => Promise<boolean>;
  bus?: EventBus;
  quota?: QuotaOptions;
  limits?: HandlerLimits;
  rememberApprovals?: readonly RememberScope[];
  onError?: (error: unknown, request: Request) => void;
}) {
  const pollMs = options.bus ? 500 : 100;
  const allowsRemember = (scope: RememberScope) =>
    options.rememberApprovals?.includes(scope) ?? true;
  const requestsPerMinute = options.limits?.requestsPerMinute ?? 600;
  const maxStreams = options.limits?.streamsPerActor ?? 8;
  const windows = new Map<string, { start: number; used: number }>();
  const streams = new Map<string, number>();
  const retryAfter = (key: string) => {
    const now = Date.now();
    if (windows.size > 10_000)
      for (const [name, window] of windows)
        if (now - window.start >= 60_000) windows.delete(name);
    let window = windows.get(key);
    if (!window || now - window.start >= 60_000) {
      window = { start: now, used: 0 };
      windows.set(key, window);
    }
    return ++window.used > requestsPerMinute
      ? window.start + 60_000 - now
      : undefined;
  };
  const report = (error: unknown, request: Request) => {
    try {
      options.onError?.(error, request);
    } catch {
      return;
    }
  };
  const sharedRetryAfter = async (
    identity: Identity,
    request: Request,
  ): Promise<number | undefined> => {
    try {
      return (
        await options.storage.quota.consume(
          JSON.stringify(["rate", identity.tenantId, identity.actorId]),
          { requests: { limit: requestsPerMinute, windowMs: 60_000 } },
        )
      )?.retryAfterMs;
    } catch (error) {
      report(error, request);
      return undefined;
    }
  };
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      vary: "Origin",
    });
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers });
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/healthz")
      return json({ status: "ok" });
    if (request.method === "GET" && path === "/readyz") {
      try {
        await options.storage.conversations.list(
          { tenantId: "readyz", actorId: "readyz" },
          undefined,
          1,
        );
        return json({ status: "ready" });
      } catch (error) {
        report(error, request);
        return json({ status: "unavailable" }, 503);
      }
    }
    if (origin && !options.origins.includes(origin))
      return json({ error: "Origin denied" }, 403);
    if (origin) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-credentials", "true");
      headers.set("access-control-expose-headers", "Retry-After");
    }
    if (request.method === "OPTIONS") {
      headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
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
      const throttle = (waitMs: number) => {
        headers.set("retry-after", String(Math.ceil(waitMs / 1000)));
        return json({ error: "Rate limit exceeded" }, 429);
      };
      const actorKey = JSON.stringify([identity.tenantId, identity.actorId]);
      const wait =
        retryAfter(actorKey) ??
        (request.method === "POST" || request.method === "DELETE"
          ? await sharedRetryAfter(identity, request)
          : undefined);
      if (wait !== undefined) return throttle(wait);
      const conversation = /^\/v1\/conversations(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
      if (conversation) {
        if (!conversation[1]) {
          if (request.method !== "GET")
            return json({ error: "Method not allowed" }, 405);
          const query = parseRequest(
            z.object({
              after: z.string().regex(/^\d+:/).optional(),
              limit: z.coerce.number().int().min(1).max(100).default(50),
            }),
            Object.fromEntries(url.searchParams),
          );
          return json(
            await options.storage.conversations.list(
              identity,
              query.after,
              query.limit,
            ),
          );
        }
        const id = decodeURIComponent(conversation[1]);
        if (request.method === "DELETE") {
          const state = await options.storage.conversations.inspect(
            identity,
            id,
          );
          if (!state.exists) return json({ error: "Not found" }, 404);
          if (state.active)
            return json({ error: "Conversation has an active run" }, 409);
          await options.storage.retention.eraseConversation(identity, id);
          return new Response(null, { status: 204, headers });
        }
        if (request.method !== "GET")
          return json({ error: "Method not allowed" }, 405);
        const loaded = await options.storage.conversations.load(identity, id);
        if (!loaded) throw new HttpError(404, "Not found");
        return json({ id, messages: visibleMessages(loaded.messages) });
      }
      const match =
        /^\/v1\/conversations\/([^/]+)\/runs(?:\/([^/]+)(?:\/(events|cancel|messages|approvals\/[^/]+(?:\/decision)?))?)?$/.exec(
          url.pathname,
        );
      if (!match?.[1]) return json({ error: "Not found" }, 404);
      const conversationId = decodeURIComponent(match[1]);
      const id = match[2] ? decodeURIComponent(match[2]) : undefined;
      if (!id && request.method === "POST") {
        const input = parseRequest(
          jobInputSchema,
          await readJson(request, maxJobBodyBytes),
        );
        if (!(await options.authorizeProfile(identity, input.profileId)))
          return json({ error: "Profile denied" }, 403);
        const { quota } = options;
        const state = await options.storage.conversations.inspect(
          identity,
          conversationId,
          input.id,
        );
        if (state.erased) throw new HttpError(410, "Conversation erased");
        const runKey = JSON.stringify([conversationId, input.id]);
        const admitted = quota && !state.active && !state.submitted;
        if (admitted) {
          const denied = await admitRun(
            options.storage.quota,
            identity,
            quota,
            runKey,
            input.profileId,
          );
          if (denied) return throttle(denied.retryAfterMs);
        }
        try {
          return json(
            await options.storage.jobs.submit(identity, conversationId, input),
            202,
          );
        } catch (error) {
          if (admitted && quota.reserveCostMicros !== undefined)
            await settleRun(options.storage.quota, identity, quota, runKey, 0);
          throw error;
        }
      }
      if (!id) return json({ error: "Method not allowed" }, 405);
      const job = await options.storage.jobs.load(identity, conversationId, id);
      if (!job) return json({ error: "Not found" }, 404);
      const recover = (current: Job) =>
        resumeDecided(options.storage, identity, conversationId, current);
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
            ...(options.rememberApprovals
              ? { remember: options.rememberApprovals }
              : {}),
          });
        if (request.method !== "POST" || !match[3].endsWith("/decision"))
          return json({ error: "Method not allowed" }, 405);
        const decision = parseRequest(
          z.strictObject({
            approved: z.boolean(),
            remember: z.enum(["run", "conversation"]).optional(),
            content: z.record(z.string(), z.unknown()).optional(),
          }),
          await readJson(request),
        );
        if (
          job.status !== "awaiting_approval" ||
          job.events.filter((item) => item.type === "awaiting_approval").at(-1)
            ?.approvalId !== approvalId
        ) {
          const applied =
            action.status === "declined"
              ? !decision.approved
              : [
                  "approved",
                  "executing",
                  "completed",
                  "unknown",
                  "undelivered",
                ].includes(action.status) && decision.approved;
          if (applied) return json({ accepted: true }, 202);
          return json({ error: "Run is not awaiting this approval" }, 409);
        }
        const content =
          decision.content ??
          (action.tool === elicitationTool && decision.approved
            ? {}
            : undefined);
        if (
          content &&
          !(
            action.tool === elicitationTool &&
            decision.approved &&
            validElicitation(action, content)
          )
        )
          return json({ error: "Invalid content" }, 400);
        const decided = await options.storage.actions.decide(
          identity,
          approvalId,
          decision.approved,
          content,
        );
        if (
          decision.remember &&
          allowsRemember(decision.remember) &&
          decided.status === "approved"
        )
          await options.storage.actions.remember(
            identity,
            decided,
            decision.remember,
          );
        await options.storage.jobs.resume(
          identity,
          conversationId,
          id,
          approvalId,
        );
        return json({ accepted: true }, 202);
      }
      if (match[3] === "messages") {
        if (request.method !== "POST")
          return json({ error: "Method not allowed" }, 405);
        await options.storage.jobs.steer(
          identity,
          conversationId,
          id,
          parseRequest(
            steeringInputSchema,
            await readJson(request, maxJobBodyBytes),
          ),
        );
        return json({ accepted: true }, 202);
      }
      if (match[3] === "cancel" && request.method === "POST") {
        await options.storage.jobs.cancel(identity, conversationId, id);
        return json({ accepted: true }, 202);
      }
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405);
      if (!match[3]) {
        await recover(job);
        return json({ ...job, history: visibleMessages(job.history) });
      }
      if (match[3] !== "events") return json({ error: "Not found" }, 404);
      let cursor = parseRequest(
        z.coerce.number().int().nonnegative(),
        url.searchParams.get("after") ?? 0,
      );
      if (cursor > job.events.length)
        return json({ error: "Invalid event cursor" }, 409);
      if ((streams.get(actorKey) ?? 0) >= maxStreams) return throttle(1000);
      const leaseKey = JSON.stringify([
        "streams",
        identity.tenantId,
        identity.actorId,
      ]);
      const leaseId = randomUUID();
      const lease = async () => {
        try {
          return await options.storage.quota.lease(
            leaseKey,
            leaseId,
            maxStreams,
            LEASE_TTL_MS,
          );
        } catch (error) {
          report(error, request);
          return true;
        }
      };
      if (!(await lease())) return throttle(1000);
      streams.set(actorKey, (streams.get(actorKey) ?? 0) + 1);
      const renewal = setInterval(() => void lease(), LEASE_TTL_MS / 3);
      renewal.unref();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearInterval(renewal);
        const open = (streams.get(actorKey) ?? 1) - 1;
        if (open) streams.set(actorKey, open);
        else streams.delete(actorKey);
        options.storage.quota
          .release(leaseKey, leaseId)
          .catch((error: unknown) => {
            report(error, request);
          });
      };
      const stopped = new AbortController();
      const signal = AbortSignal.any([request.signal, stopped.signal]);
      const encoder = new TextEncoder();
      const pending: RunEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = options.bus?.subscribe(
        eventKey(identity, conversationId, id),
        (event) => {
          const last = pending.at(-1);
          if (last && last.sequence === event.sequence)
            pending[pending.length - 1] = {
              ...last,
              text: (last.text ?? "") + (event.text ?? ""),
            };
          else pending.push(event);
          wake?.();
        },
      );
      const idle = (ms: number) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake = undefined;
            resolve();
          };
          const timer = setTimeout(done, ms);
          wake = done;
          signal.addEventListener("abort", done);
        });
      let authenticatedAt = Date.now();
      let loadedAt = 0;
      headers.set("content-type", "application/x-ndjson; charset=utf-8");
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const send = (event: RunEvent) => {
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            };
            try {
              for (;;) {
                signal.throwIfAborted();
                const live = pending.splice(0);
                if (
                  Date.now() - loadedAt < pollMs &&
                  live.every((event) => event.sequence <= cursor)
                ) {
                  for (const event of live) send(event);
                  if (live.length) return;
                  if (!pending.length)
                    await idle(pollMs - (Date.now() - loadedAt));
                  continue;
                }
                if (Date.now() - authenticatedAt >= 5000) {
                  const currentIdentity = await options.authenticate(request);
                  if (
                    currentIdentity?.actorId !== identity.actorId ||
                    currentIdentity.tenantId !== identity.tenantId
                  )
                    throw new Error("Access revoked");
                  authenticatedAt = Date.now();
                }
                const current = await options.storage.jobs.load(
                  identity,
                  conversationId,
                  id,
                );
                loadedAt = Date.now();
                if (!current) throw new Error("Run removed");
                await recover(current);
                const events = current.events.filter(
                  (event) => event.sequence > cursor,
                );
                const flush = (through: number) => {
                  for (const event of events) {
                    if (event.sequence > through || event.sequence <= cursor)
                      continue;
                    send(event);
                    cursor = event.sequence;
                  }
                };
                for (const event of live) {
                  flush(event.sequence);
                  send(event);
                }
                flush(Infinity);
                if (isTerminal(current.status)) {
                  unsubscribe?.();
                  release();
                  controller.close();
                  return;
                }
                if (events.length || live.length) return;
                if (!pending.length) await idle(pollMs);
              }
            } catch (error) {
              unsubscribe?.();
              release();
              if (!request.signal.aborted && !stopped.signal.aborted)
                report(error, request);
              controller.error(new Error("Event stream disconnected"));
            }
          },
          cancel() {
            unsubscribe?.();
            release();
            stopped.abort();
          },
        }),
        { headers },
      );
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message }, error.status);
      if (error instanceof JobConflict || error instanceof ActionConflict)
        return json({ error: error.message }, 409);
      if (error instanceof SyntaxError || error instanceof URIError)
        return json({ error: "Invalid request" }, 400);
      if (error instanceof RangeError)
        return json({ error: "Request too large" }, 413);
      report(error, request);
      return json({ error: "Request failed" }, 503);
    }
  };
}
