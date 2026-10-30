import { expect, it, describe } from "vitest";
import { createFakeProvider } from "yada";
import {
  createStarterApp,
  type StarterAssets,
} from "../examples/starter/app.js";
import { starterConfigFromEnv } from "../examples/starter/config.js";
import { starterIdentity } from "../examples/starter/auth.js";
import { drivers, storageFixture } from "./helpers/storage.js";

const origin = "http://localhost:3000";
const password = "a-generated-private-starter-password";
const config = starterConfigFromEnv({
  YADA_STARTER_PASSWORD: password,
  YADA_STORAGE_KEY: "ab".repeat(32),
  YADA_LLM_PROVIDER: "anthropic",
  YADA_LLM_API_KEY: "secret-provider-key",
});
const assets: StarterAssets = {
  "/": "<h1>Yada</h1>",
  "/assets/client.js": "export {};",
  "/assets/style.css": "body{}",
};

for (const driver of drivers)
  describe(`${driver} starter composition`, () => {
    it("protects real run submission, uses tools and preserves history across restart", async () => {
      const fixture = await storageFixture(driver);
      const provider = createFakeProvider((request) =>
        request.messages.some((turn) => turn.role === "tool")
          ? {
              content: "Your guide is ready.",
              toolCalls: [],
              finishReason: "stop",
            }
          : {
              content: "",
              toolCalls: [{ id: "guide-1", name: "starter_guide", args: {} }],
              finishReason: "tool_calls",
            },
      );
      const start = () =>
        createStarterApp({
          config: { ...config, storage: fixture.config },
          storage: fixture.storage,
          provider,
          assets,
        });
      let app = await start();
      const send = (
        path: string,
        method = "GET",
        body?: unknown,
        cookie?: string,
        requestOrigin: string | null = origin,
      ) =>
        app.handle(
          new Request(origin + path, {
            method,
            headers: {
              ...(cookie ? { cookie } : {}),
              ...(requestOrigin ? { origin: requestOrigin } : {}),
              ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
      const login = async () => {
        const response = await send("/auth/login", "POST", { password });
        expect(response.status).toBe(200);
        const cookie = response.headers.get("set-cookie")?.split(";")[0];
        if (!cookie) throw new Error("Missing session cookie");
        return cookie;
      };
      try {
        const submission = {
          id: "first",
          profileId: "starter",
          input: "Read the starter guide",
        };
        expect(
          (await send("/v1/conversations/chat/runs", "POST", submission))
            .status,
        ).toBe(401);
        const cookie = await login();
        for (const badOrigin of [null, "https://other.test"])
          expect(
            (
              await send(
                "/v1/conversations/chat/runs",
                "POST",
                submission,
                cookie,
                badOrigin,
              )
            ).status,
          ).toBeGreaterThanOrEqual(400);
        expect(
          (
            await send(
              "/v1/conversations/chat/runs",
              "POST",
              { ...submission, profileId: "admin" },
              cookie,
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await send(
              "/v1/conversations/chat/runs",
              "POST",
              submission,
              cookie,
            )
          ).status,
        ).toBe(202);
        await app.worker.tick();
        const job = await fixture.storage.jobs.load(
          starterIdentity,
          "chat",
          "first",
        );
        expect(job?.status).toBe("completed");
        expect(
          (await fixture.storage.conversations.load(starterIdentity, "chat"))
            ?.messages,
        ).toHaveLength(2);
        const events = await send(
          "/v1/conversations/chat/runs/first/events",
          "GET",
          undefined,
          cookie,
        );
        expect(await events.text()).toContain("Your guide is ready.");
        await app.close();
        await fixture.reopen();
        app = await start();
        expect(
          (await send("/auth/session", "GET", undefined, cookie)).status,
        ).toBe(401);
        const nextCookie = await login();
        expect(
          (
            await send(
              "/v1/conversations/chat/runs/first",
              "GET",
              undefined,
              nextCookie,
            )
          ).status,
        ).toBe(200);
        expect(
          (await fixture.storage.conversations.load(starterIdentity, "chat"))
            ?.messages,
        ).toHaveLength(2);
        expect(
          (await send("/auth/logout", "POST", undefined, nextCookie)).status,
        ).toBe(200);
        expect(
          (
            await send(
              "/v1/conversations/chat/runs/first",
              "GET",
              undefined,
              nextCookie,
            )
          ).status,
        ).toBe(401);
        for (const path of Object.keys(assets)) {
          const response = await send(path);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-security-policy")).toContain(
            "frame-ancestors 'none'",
          );
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(await response.text()).not.toContain(config.password);
        }
        expect((await send("/.env.starter")).status).toBe(404);
        expect((await send("/../config.ts")).status).toBe(404);
        expect(provider.requests).toHaveLength(2);
      } finally {
        await app.close();
      }
    });
  });
