import { createHash, timingSafeEqual } from "node:crypto";
import { createStarterCookies } from "./cookies.js";
import { z } from "zod";
import type { Identity } from "@edgaralochi/yada";

export const starterIdentity: Identity = Object.freeze({
  actorId: "owner",
  tenantId: "starter",
});
const passwordBody = z.strictObject({ password: z.string().max(256) });
const optionsSchema = z.strictObject({
  password: z.union([z.literal(""), z.string().min(24).max(256)]).default(""),
  sessionKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
  origin: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      value === url.origin &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }),
});

async function readPassword(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing login body");
  const cancelled = new AbortController();
  const cancel = () => {
    cancelled.abort();
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(cancel, 5000);
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 2048) throw new RangeError("Login body too large");
      chunks.push(part.value);
    }
    cancelled.signal.throwIfAborted();
    return passwordBody.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    ).password;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createStarterAuth(options: {
  password?: string;
  sessionKey: string;
  origin: string;
}) {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success)
    throw new Error("Invalid starter authentication configuration");
  const { password, sessionKey, origin } = parsed.data;
  const passwordHash = password
    ? createHash("sha256").update(password).digest()
    : undefined;
  const cookies = passwordHash
    ? createStarterCookies(
        Buffer.concat([Buffer.from(sessionKey, "hex"), passwordHash]),
        origin.startsWith("https:"),
      )
    : undefined;
  let attempts = 0;
  let windowEnds = 0;
  const json = (
    body: Record<string, unknown>,
    status = 200,
    headers?: Record<string, string>,
  ) =>
    Response.json(body, {
      status,
      headers: { "cache-control": "no-store", ...headers },
    });
  const isAllowedMutation = (request: Request) =>
    ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    request.headers.get("origin") === origin;
  const authenticate = (request: Request): Promise<Identity | undefined> =>
    Promise.resolve(
      isAllowedMutation(request) && (!cookies || cookies.has(request))
        ? starterIdentity
        : undefined,
    );
  return {
    authenticate,
    isAllowedMutation,
    async handle(request: Request): Promise<Response | undefined> {
      const path = new URL(request.url).pathname;
      if (!["/auth/login", "/auth/logout", "/auth/session"].includes(path))
        return undefined;
      if (path === "/auth/session") {
        if (request.method !== "GET")
          return json({ error: "Method not allowed" }, 405);
        const identity = await authenticate(request);
        return identity
          ? json({ authenticated: true, identity, passwordRequired: !!cookies })
          : json({ authenticated: false, passwordRequired: true }, 401);
      }
      if (request.method !== "POST")
        return json({ error: "Method not allowed" }, 405);
      if (!isAllowedMutation(request))
        return json({ error: "Origin denied" }, 403);
      if (!cookies || !passwordHash)
        return json({
          authenticated: true,
          identity: starterIdentity,
          passwordRequired: false,
        });
      if (path === "/auth/logout")
        return json({ authenticated: false }, 200, {
          "set-cookie": cookies.logout(request),
        });
      if (Date.now() >= windowEnds) {
        attempts = 0;
        windowEnds = Date.now() + 60_000;
      }
      if (attempts >= 10)
        return json({ error: "Too many login attempts" }, 429, {
          "retry-after": String(
            Math.max(1, Math.ceil((windowEnds - Date.now()) / 1000)),
          ),
        });
      attempts++;
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        return json({ error: "JSON login body required" }, 415);
      let candidate: string;
      try {
        candidate = await readPassword(request);
      } catch (error) {
        return error instanceof RangeError
          ? json({ error: "Login request too large" }, 413)
          : json({ error: "Invalid login request" }, 400);
      }
      if (
        !timingSafeEqual(
          passwordHash,
          createHash("sha256").update(candidate).digest(),
        )
      )
        return json({ error: "Invalid credentials" }, 401);
      return json({ authenticated: true }, 200, {
        "set-cookie": cookies.issue(),
      });
    },
  };
}
