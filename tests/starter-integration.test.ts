import { it, expect } from "vitest";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createFakeProvider, createNodeServer } from "yada";
import { createStarterApp } from "../examples/starter/app.js";
import { starterConfigFromEnv } from "../examples/starter/config.js";
import { storageFixture } from "./helpers/storage.js";

it("runs the bundled widget against real starter auth and durable storage, then resumes after restart", async () => {
  const fixture = await storageFixture("sqlite");
  const bundle = await build({
    entryPoints: ["examples/starter/client.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
  });
  const script = bundle.outputFiles[0]?.text;
  if (!script) throw new Error("Missing browser bundle");
  const password = "generated-starter-password-123";
  const provider = createFakeProvider(() => ({
    content: "Your private workspace answer.",
    toolCalls: [],
    finishReason: "stop",
  }));
  let app: Awaited<ReturnType<typeof createStarterApp>> | undefined;
  const server = createNodeServer((request) =>
    app
      ? app.handle(request)
      : Promise.resolve(new Response(null, { status: 503 })),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const config = starterConfigFromEnv({
    YADA_STARTER_ORIGIN: origin,
    YADA_STARTER_PASSWORD: password,
    YADA_STORAGE_KEY: "ab".repeat(32),
    YADA_LLM_PROVIDER: "anthropic",
    YADA_LLM_API_KEY: "never-browser-visible",
  });
  const assets = {
    "/": await readFile("examples/starter/public/index.html", "utf8"),
    "/assets/client.js": script,
    "/assets/style.css": await readFile(
      "examples/starter/public/style.css",
      "utf8",
    ),
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const start = async () => {
      app = await createStarterApp({
        config: { ...config, storage: fixture.config },
        storage: fixture.storage,
        assets,
        provider,
      });
      app.worker.start();
    };
    await start();
    const page = await browser.newPage();
    const violations: string[] = [];
    page.on("console", (event) => {
      if (
        event.type() === "error" &&
        event.text().includes("Content Security Policy")
      )
        violations.push(event.text());
    });
    await page.goto(origin);
    await page.getByLabel("Workspace password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .getByText("Your private workspace answer.", { exact: true })
      .waitFor();
    expect(provider.requests).toHaveLength(1);
    const saved = await page.evaluate(() =>
      localStorage.getItem("yada-starter:run"),
    );
    expect(saved).toBeTruthy();
    await app?.close();
    await fixture.reopen();
    await start();
    await page.reload();
    await page.getByLabel("Workspace password").waitFor();
    expect(
      await page
        .getByText("Your private workspace answer.", { exact: true })
        .count(),
    ).toBe(0);
    expect(
      await page.evaluate(() => localStorage.getItem("yada-starter:run")),
    ).toBe(saved);
    await page.getByLabel("Workspace password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByText("Your private workspace answer.", { exact: true })
      .waitFor();
    expect(provider.requests).toHaveLength(1);
    expect(await page.evaluate(() => document.cookie)).toBe("");
    expect(script).not.toContain("never-browser-visible");
    expect(violations).toEqual([]);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await app?.close();
  }
}, 30_000);
