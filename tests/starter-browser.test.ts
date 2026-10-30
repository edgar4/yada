import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { once } from "node:events";
import { readFile, mkdir } from "node:fs/promises";
import ts from "typescript";
import { createNodeServer } from "../src/service/node.js";
import { jobInputSchema, type Job } from "../src/service/contracts.js";
import { browserModules } from "./helpers/browser-modules.js";

const password = "starter-password-for-tests-only";
const malicious = '<img src=x onerror="globalThis.compromised=true">';
let authenticated = false;
let sessionFailure = false;
let logoutFailure = false;
let loginRequested = false;
let loginGate: Promise<void> | undefined;
let submissions = 0;
const jobs = new Map<string, Job>();
const importMap =
  '<script type="importmap">{"imports":{"yada/client":"/src/client/index.js","yada/widget":"/src/widget/index.js","zod":"/node_modules/zod/index.js"}}</script>';
const server = createNodeServer(async (request) => {
  const path = new URL(request.url).pathname;
  if (path === "/") {
    const html = await readFile("examples/starter/public/index.html", "utf8");
    return new Response(html.replace("<head>", `<head>${importMap}`), {
      headers: { "content-type": "text/html" },
    });
  }
  if (path === "/assets/style.css")
    return new Response(await readFile("examples/starter/public/style.css"), {
      headers: { "content-type": "text/css" },
    });
  if (path === "/assets/client.js")
    return new Response(
      ts.transpileModule(await readFile("examples/starter/client.ts", "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
      { headers: { "content-type": "application/javascript" } },
    );
  const valid =
    authenticated && request.headers.get("cookie")?.includes("starter=test");
  if (path === "/auth/session")
    return Response.json(
      { authenticated: !!valid },
      { status: sessionFailure ? 503 : valid ? 200 : 401 },
    );
  if (path === "/auth/login") {
    loginRequested = true;
    await loginGate;
    const body: unknown = await request.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("password" in body) ||
      body.password !== password
    )
      return Response.json({ authenticated: false }, { status: 401 });
    authenticated = true;
    return Response.json(
      { authenticated: true },
      {
        headers: {
          "set-cookie": "starter=test; Path=/; HttpOnly; SameSite=Strict",
        },
      },
    );
  }
  if (path === "/auth/logout") {
    if (logoutFailure) return Response.json({}, { status: 503 });
    authenticated = false;
    return Response.json(
      { authenticated: false },
      {
        headers: {
          "set-cookie":
            "starter=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        },
      },
    );
  }
  if (path.startsWith("/v1/")) {
    if (!valid) return Response.json({}, { status: 401 });
    if (request.method === "POST") {
      submissions++;
      const input = jobInputSchema.parse(await request.json());
      expect(input.profileId).toBe("starter");
      const job: Job = {
        ...input,
        createdAt: 1,
        updatedAt: 1,
        availableAt: 0,
        status: "completed",
        cancelRequested: false,
        history: [],
        outcome: { status: "completed", text: input.input },
        events: [
          { version: 1, sequence: 1, type: "queued", at: 1 },
          {
            version: 1,
            sequence: 2,
            type: "completed",
            at: 1,
            text: input.input,
          },
        ],
      };
      jobs.set(input.id, job);
      return Response.json(job, { status: 202 });
    }
    const runId = path.split("/")[5] ?? "";
    const job = jobs.get(runId);
    if (!job) return Response.json({}, { status: 404 });
    if (path.endsWith("/events"))
      return new Response(
        job.events.map((event) => JSON.stringify(event)).join("\n"),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    return Response.json(job);
  }
  return browserModules(request, "");
});
let browser: Browser;
let origin: string;
const open = async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByLabel("Workspace password", { exact: true }).waitFor();
  return page;
};
const signIn = async (page: Awaited<ReturnType<typeof open>>) => {
  await page.getByLabel("Workspace password", { exact: true }).fill(password);
  await page.keyboard.press("Enter");
  await page
    .locator("yada-chat")
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor();
};
beforeAll(async () => {
  await mkdir("work", { recursive: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  origin = `http://127.0.0.1:${String(address.port)}`;
  browser = await chromium.launch({ headless: true });
});
afterEach(async () => {
  for (const context of browser.contexts()) await context.close();
});
afterAll(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});
beforeEach(() => {
  authenticated = sessionFailure = logoutFailure = loginRequested = false;
  loginGate = undefined;
  submissions = 0;
  jobs.clear();
});

it("signs in with HttpOnly cookies, reuses the widget and resumes without resubmission", async () => {
  const page = await open();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "work/starter-login.png", fullPage: true });
  await signIn(page);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(
    (await page.context().cookies()).find((cookie) => cookie.name === "starter")
      ?.httpOnly,
  ).toBe(true);
  const widget = page.locator("yada-chat");
  await widget
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(malicious);
  await widget.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => widget.getByRole("status").textContent())
    .toBe("completed");
  const persisted = await page.evaluate(() => ({
    conversation: localStorage.getItem("yada-starter:conversation"),
    run: localStorage.getItem("yada-starter:run"),
    values: Object.values(localStorage),
  }));
  expect(persisted.conversation).toBeTruthy();
  expect(persisted.run).toBeTruthy();
  expect(persisted.values.join("")).not.toContain(password);
  expect(await widget.locator("img").count()).toBe(0);
  expect(
    await page.evaluate(
      () => Reflect.get(globalThis, "compromised") as unknown,
    ),
  ).toBeUndefined();
  await page.reload();
  await expect
    .poll(async () =>
      page.locator("yada-chat").getByRole("status").textContent(),
    )
    .toBe("completed");
  expect(submissions).toBe(1);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("yada-starter:conversation"),
    ),
  ).toBe(persisted.conversation);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "work/starter-chat.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "work/starter-chat-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Workspace password", { exact: true }).waitFor();
  expect(await page.locator("yada-chat").count()).toBe(0);
  expect(
    await page.evaluate(() => localStorage.getItem("yada-starter:run")),
  ).toBeNull();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("yada-starter:conversation"),
    ),
  ).toBe(persisted.conversation);
});

it("announces rejected credentials and disables duplicate pending logins", async () => {
  const page = await open();
  await page.getByLabel("Workspace password", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect
    .poll(async () => page.locator("#error").textContent())
    .toBe("That password was not accepted.");
  let release = () => {};
  loginGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  loginRequested = false;
  await page.getByLabel("Workspace password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect.poll(() => loginRequested).toBe(true);
  expect(
    await page
      .getByRole("button", { name: "Sign in", exact: true })
      .isDisabled(),
  ).toBe(true);
  expect(
    await page.getByLabel("Workspace password", { exact: true }).inputValue(),
  ).toBe("");
  expect(await page.locator("#status").textContent()).toBe("Signing in…");
  release();
  await page.locator("yada-chat").waitFor();
});

it("clears the saved run when an authenticated API request loses its session", async () => {
  const page = await open();
  await signIn(page);
  authenticated = false;
  const widget = page.locator("yada-chat");
  await widget
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello");
  await widget.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByLabel("Workspace password", { exact: true }).waitFor();
  expect(await page.locator("#error").textContent()).toBe(
    "Your session has expired. Sign in again.",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("yada-starter:run")),
  ).toBeNull();
  expect(await page.locator("yada-chat").count()).toBe(0);
});

it("offers retry when session checking fails and keeps failed logout explicit", async () => {
  sessionFailure = true;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
  expect(await page.locator("#error").textContent()).toBe(
    "Could not check your session. Try again.",
  );
  sessionFailure = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await signIn(page);
  logoutFailure = true;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect
    .poll(async () => page.locator("#status").textContent())
    .toBe("Sign out not confirmed.");
  expect(await page.locator("#error").textContent()).toBe(
    "Could not sign out. Try again.",
  );
  logoutFailure = false;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Workspace password", { exact: true }).waitFor();
});

it("drops a missing saved run and signs out when the session expires across reload", async () => {
  const page = await open();
  await signIn(page);
  const widget = page.locator("yada-chat");
  await widget
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello");
  await widget.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => widget.getByRole("status").textContent())
    .toBe("completed");
  jobs.clear();
  await page.reload();
  await expect
    .poll(async () => page.locator("#status").textContent())
    .toContain("previous run is no longer available");
  expect(
    await page.evaluate(() => localStorage.getItem("yada-starter:run")),
  ).toBeNull();
  expect(
    await page
      .locator("yada-chat")
      .getByRole("textbox", { name: "Message", exact: true })
      .isDisabled(),
  ).toBe(false);
  await page.evaluate(() => {
    localStorage.setItem("yada-starter:run", "stale-run");
  });
  authenticated = false;
  await page.reload();
  await page.getByLabel("Workspace password", { exact: true }).waitFor();
  expect(
    await page.evaluate(() => localStorage.getItem("yada-starter:run")),
  ).toBeNull();
  expect(await page.locator("#error").textContent()).toBe("");
});
