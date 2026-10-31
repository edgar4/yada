import { afterEach, expect, it, vi } from "vitest";
import {
  createStarterAuth,
  starterIdentity,
} from "../examples/starter/auth.js";

const password = "starter-password-long-enough-for-login";
const origin = "http://localhost:3000";
const options = { password, origin, sessionKey: "ab".repeat(32) };
type Auth = ReturnType<typeof createStarterAuth>;

it.each([{}, { password: "" }])(
  "allows cookie-free access with an optional password: %j",
  async (setting) => {
    const auth = createStarterAuth({
      origin,
      sessionKey: options.sessionKey,
      ...setting,
    });
    expect(
      await auth.authenticate(
        new Request(origin + "/v1/conversations/chat/runs"),
      ),
    ).toEqual(starterIdentity);
    const session = await auth.handle(new Request(origin + "/auth/session"));
    expect(await session?.json()).toEqual({
      authenticated: true,
      identity: starterIdentity,
      passwordRequired: false,
    });
    expect(session?.headers.get("set-cookie")).toBeNull();
    for (const path of ["/auth/login", "/auth/logout"]) {
      const result = await auth.handle(
        new Request(origin + path, { method: "POST", headers: { origin } }),
      );
      expect(result?.status).toBe(200);
      expect(result?.headers.get("set-cookie")).toBeNull();
      expect(
        (await auth.handle(new Request(origin + path, { method: "POST" })))
          ?.status,
      ).toBe(403);
    }
    for (const supplied of [undefined, "https://other.test"])
      expect(
        await auth.authenticate(authenticated("", "POST", supplied)),
      ).toBeUndefined();
    expect(await auth.authenticate(authenticated("", "POST", origin))).toEqual(
      starterIdentity,
    );
  },
);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function handle(auth: Auth, request: Request) {
  const response = await auth.handle(request);
  if (!response) throw new Error("Missing auth response");
  return response;
}
function cookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";")[0];
  if (!value) throw new Error("Missing session cookie");
  return value;
}
async function login(auth: Auth, supplied = password) {
  return handle(auth, post("/auth/login", { password: supplied }));
}
function authenticated(token: string, method = "GET", suppliedOrigin?: string) {
  return new Request(`${origin}/v1/conversations/chat/runs`, {
    method,
    headers: {
      cookie: token,
      ...(suppliedOrigin === undefined ? {} : { origin: suppliedOrigin }),
    },
  });
}
it.each([
  { password: "x".repeat(23) },
  { password: "x".repeat(257) },
  { sessionKey: "private-short-key" },
  { origin: "not a URL" },
  { origin: "http://remote.example" },
  { origin: "https://user:secret@example.com" },
  { origin: "https://example.com/path" },
  { origin: "https://example.com?x=1" },
  { origin: "https://example.com/" },
])("rejects invalid configuration without echoing secrets: %j", (change) => {
  expect(() => createStarterAuth({ ...options, ...change })).toThrow(
    "Invalid starter authentication configuration",
  );
});
it("issues a host-only signed session and returns only the server-owned identity", async () => {
  const auth = createStarterAuth(options);
  const empty = await handle(auth, new Request(`${origin}/auth/session`));
  expect(empty.status).toBe(401);
  expect(await empty.json()).toEqual({
    authenticated: false,
    passwordRequired: true,
  });
  const response = await login(auth);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authenticated: true });
  const header = response.headers.get("set-cookie");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=Strict");
  expect(header).toContain("Path=/");
  expect(header).toContain("Max-Age=28800");
  expect(header).not.toContain("; Secure");
  expect(header).not.toContain("Domain=");
  const token = cookie(response);
  expect(token).not.toContain(password);
  expect(token).not.toContain(options.sessionKey);
  expect(await auth.authenticate(authenticated(token))).toEqual(
    starterIdentity,
  );
  const session = await handle(
    auth,
    new Request(`${origin}/auth/session?actorId=other&tenantId=other`, {
      headers: { cookie: token },
    }),
  );
  expect(session.status).toBe(200);
  expect(session.headers.get("cache-control")).toBe("no-store");
  expect(await session.json()).toEqual({
    authenticated: true,
    identity: { actorId: "owner", tenantId: "starter" },
    passwordRequired: true,
  });
  const forged = await handle(
    auth,
    post("/auth/login", {
      password,
      identity: { actorId: "other", tenantId: "other" },
    }),
  );
  expect(forged.status).toBe(400);
  expect(forged.headers.has("set-cookie")).toBe(false);
});
it("sets Secure on HTTPS sessions and clears the same protected cookie on logout", async () => {
  const secureOrigin = "https://starter.example";
  const auth = createStarterAuth({ ...options, origin: secureOrigin });
  const response = await handle(
    auth,
    new Request(`${secureOrigin}/auth/login`, {
      method: "POST",
      headers: { origin: secureOrigin, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  );
  expect(response.headers.get("set-cookie")).toContain("; Secure");
  const cleared = await handle(
    auth,
    new Request(`${secureOrigin}/auth/logout`, {
      method: "POST",
      headers: { origin: secureOrigin, cookie: cookie(response) },
    }),
  );
  expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0; Secure");
  expect(
    await auth.authenticate(authenticated(cookie(response))),
  ).toBeUndefined();
});
it.each(["POST", "PUT", "PATCH", "DELETE"])(
  "requires an exact Origin for authenticated %s API requests",
  async (method) => {
    const auth = createStarterAuth(options);
    const token = cookie(await login(auth));
    for (const value of [
      undefined,
      "null",
      "https://evil.example",
      "http://localhost:3001",
    ]) {
      const request = authenticated(token, method, value);
      expect(auth.isAllowedMutation(request)).toBe(false);
      expect(await auth.authenticate(request)).toBeUndefined();
    }
    expect(
      await auth.authenticate(authenticated(token, method, origin)),
    ).toEqual(starterIdentity);
  },
);
it("rejects cross-origin login/logout without consuming guesses or revoking an existing session", async () => {
  const auth = createStarterAuth(options);
  const token = cookie(await login(auth));
  for (let index = 0; index < 12; index++) {
    expect(
      (
        await handle(
          auth,
          post("/auth/login", { password }, { origin: "https://evil.example" }),
        )
      ).status,
    ).toBe(403);
  }
  const logout = await handle(
    auth,
    post("/auth/logout", {}, { origin: "https://evil.example", cookie: token }),
  );
  expect(logout.status).toBe(403);
  expect(logout.headers.has("set-cookie")).toBe(false);
  expect(await auth.authenticate(authenticated(token))).toEqual(
    starterIdentity,
  );
  const missing = new Request(`${origin}/auth/logout`, {
    method: "POST",
    headers: { cookie: token },
  });
  expect((await handle(auth, missing)).status).toBe(403);
  expect((await login(auth)).status).toBe(200);
});
it("revokes the exact signed cookie on logout while retaining other sessions", async () => {
  const auth = createStarterAuth(options);
  const first = cookie(await login(auth));
  const second = cookie(await login(auth));
  const response = await handle(
    auth,
    post("/auth/logout", {}, { cookie: first }),
  );
  expect(await response.json()).toEqual({ authenticated: false });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await auth.authenticate(authenticated(first))).toBeUndefined();
  expect(await auth.authenticate(authenticated(second))).toEqual(
    starterIdentity,
  );
  await handle(auth, post("/auth/logout", {}, { cookie: "forged" }));
  expect(await auth.authenticate(authenticated(second))).toEqual(
    starterIdentity,
  );
});
it("rejects malformed, duplicated, expired, tampered and previous-process cookies", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
  const auth = createStarterAuth(options);
  const token = cookie(await login(auth));
  const [name, value] = token.split("=");
  if (!name || !value) throw new Error("Malformed minted cookie");
  const [nonce, expiry, signature] = value.split(".");
  if (!nonce || !expiry || !signature)
    throw new Error("Malformed minted token");
  const expired = `${name}=${nonce}.1.${signature}`;
  for (const invalid of [
    "",
    "forged",
    `${token}; ${token}`,
    `${token}=`,
    `${name}=x.${expiry}.${signature}`,
    `${name}=${nonce}.9999999999999999.${signature}`,
    `${name}=${nonce}.${expiry}.${"A".repeat(43)}`,
    expired,
    "x".repeat(8193),
  ])
    expect(await auth.authenticate(authenticated(invalid))).toBeUndefined();
  expect(
    await createStarterAuth(options).authenticate(authenticated(token)),
  ).toBeUndefined();
  expect(
    await createStarterAuth({
      ...options,
      password: "a different sufficiently long password",
    }).authenticate(authenticated(token)),
  ).toBeUndefined();
  expect(
    await createStarterAuth({
      ...options,
      sessionKey: "cd".repeat(32),
    }).authenticate(authenticated(token)),
  ).toBeUndefined();
  vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
  expect(await auth.authenticate(authenticated(token))).toBeUndefined();
});
it("bounds global guesses and cannot be bypassed with forwarded address headers", async () => {
  vi.useFakeTimers();
  const auth = createStarterAuth(options);
  for (let index = 0; index < 10; index++) {
    const response = await handle(
      auth,
      post(
        "/auth/login",
        { password: "wrong" },
        { "x-forwarded-for": `192.0.2.${String(index)}` },
      ),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid credentials" });
    expect(response.headers.has("set-cookie")).toBe(false);
  }
  const limited = await login(auth);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  vi.setSystemTime(Date.now() + 60_001);
  expect((await login(auth)).status).toBe(200);
});
it.each([
  null,
  [],
  { password: 1 },
  { password: "a".repeat(257) },
  { password, actorId: "other" },
])("rejects malformed login payload %j", async (body) => {
  const auth = createStarterAuth(options);
  const response = await handle(auth, post("/auth/login", body));
  expect(response.status).toBe(400);
  expect(response.headers.has("set-cookie")).toBe(false);
});
it("bounds streamed bytes and cancels oversized bodies even with a forged Content-Length", async () => {
  const auth = createStarterAuth(options);
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024));
      controller.enqueue(new Uint8Array(1025));
    },
    cancel: cancelled,
  });
  const request = new Request(`${origin}/auth/login`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "content-length": "1",
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await handle(auth, request);
  expect(response.status).toBe(413);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(response.headers.has("set-cookie")).toBe(false);
});
it("bounds incomplete body readers even when the source's cancellation never resolves", async () => {
  vi.useFakeTimers();
  const auth = createStarterAuth(options);
  const cancelled = vi.fn(() => new Promise<void>(() => {}));
  const request = new Request(`${origin}/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: new ReadableStream({ cancel: cancelled }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = handle(auth, request);
  await vi.advanceTimersByTimeAsync(5000);
  expect((await response).status).toBe(400);
  expect(cancelled).toHaveBeenCalledOnce();
});
it("honors aborted bodies and redacts stream failures", async () => {
  const auth = createStarterAuth(options);
  const controller = new AbortController();
  const request = new Request(`${origin}/auth/login`, {
    method: "POST",
    signal: controller.signal,
    headers: { origin, "content-type": "application/json" },
    body: new ReadableStream(),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const pending = handle(auth, request);
  controller.abort();
  expect((await pending).status).toBe(400);
  const broken = new ReadableStream({
    start(stream) {
      stream.error(new Error("private-stream-secret"));
    },
  });
  const failure = await handle(
    auth,
    new Request(`${origin}/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: broken,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
  expect(failure.status).toBe(400);
  expect(await failure.text()).not.toContain("private");
});
it("rejects invalid UTF-8, JSON and media types and respects password boundaries", async () => {
  const auth = createStarterAuth(options);
  for (const body of [
    new Uint8Array([255]),
    new TextEncoder().encode("not JSON"),
  ])
    expect(
      (
        await handle(
          auth,
          new Request(`${origin}/auth/login`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body,
          }),
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await handle(
        auth,
        post("/auth/login", { password }, { "content-type": "text/plain" }),
      )
    ).status,
  ).toBe(415);
  for (const length of [24, 256]) {
    const candidate = "x".repeat(length);
    const bounded = createStarterAuth({ ...options, password: candidate });
    expect((await login(bounded, candidate)).status).toBe(200);
  }
});
it("rotates the process key at the revocation bound without resurrecting logged-out cookies", async () => {
  vi.useFakeTimers();
  const auth = createStarterAuth(options);
  const live = cookie(await login(auth));
  let first = "";
  for (let index = 0; index < 129; index++) {
    vi.setSystemTime(Date.now() + 60_001);
    const token = cookie(await login(auth));
    if (index === 0) first = token;
    await handle(auth, post("/auth/logout", {}, { cookie: token }));
    expect(await auth.authenticate(authenticated(token))).toBeUndefined();
  }
  expect(await auth.authenticate(authenticated(first))).toBeUndefined();
  expect(await auth.authenticate(authenticated(live))).toBeUndefined();
  const fresh = cookie(await login(auth));
  expect(await auth.authenticate(authenticated(fresh))).toEqual(
    starterIdentity,
  );
});
it("leaves unrelated routes alone and rejects unsupported auth methods", async () => {
  const auth = createStarterAuth(options);
  expect(await auth.handle(new Request(`${origin}/other`))).toBeUndefined();
  for (const path of ["/auth/login", "/auth/logout"])
    expect((await handle(auth, new Request(`${origin}${path}`))).status).toBe(
      405,
    );
  expect((await handle(auth, post("/auth/session", {}))).status).toBe(405);
});
