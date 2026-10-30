import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { defineYadaWidget, type YadaWidget } from "../src/widget/index.js";

const malicious = '<img src=x onerror="globalThis.compromised=true">';
const queued = { version: 1, sequence: 1, type: "queued", at: 1 };
const waiting = {
  version: 1,
  sequence: 2,
  type: "awaiting_approval",
  at: 1,
  approvalId: "action",
  text: malicious,
};
let decision: boolean | undefined;
let cancelRequested = false;
let reconnectOnce = false;
let createFailure = false;
let decisionFailure = false;
let cancelFailure = false;
let connections = 0;
let closed = 0;
const cursors: string[] = [];
const inputs: string[] = [];
const streams = new Set<ServerResponse>();
const finish = (type: string) => {
  for (const response of streams)
    response.end(
      `${JSON.stringify({ version: 1, sequence: 3, type, at: 1, text: malicious })}\n`,
    );
  streams.clear();
};
const html = `<!doctype html><html lang="en"><head><title>Widget test</title><style>
body { background:#f4f5f8; } button { background:rgb(255,0,0)!important; } textarea { display:none!important; }
.retail { --yada-accent:#1d4ed8; --yada-radius:18px; max-width:560px; }
.console { --yada-accent:#be185d; --yada-radius:0px; --yada-font:16px/1.5 monospace; max-width:560px; }
</style><script type="importmap">{"imports":{"zod":"/node_modules/zod/index.js"}}</script></head>
<body><main><h1>Host application</h1><div class="retail"><yada-chat></yada-chat></div><div class="console"><yada-chat></yada-chat></div></main>
<script type="module">import { BrowserClient } from '/src/client/index.js'; import { defineYadaWidget } from '/src/widget/index.js';
defineYadaWidget(); defineYadaWidget();
for (const widget of document.querySelectorAll('yada-chat')) widget.configure({client:new BrowserClient({baseUrl:location.origin+'/api',reconnectDelayMs:5,maxRetries:1}),conversationId:'chat',profileId:'support'});
</script></body></html>`;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/") {
    response.setHeader("content-type", "text/html");
    response.end(html);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && url.pathname.endsWith("/runs")) {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        inputs.push(body);
        if (createFailure) {
          response.writeHead(503);
          response.end("{}");
          return;
        }
        const input: unknown = JSON.parse(body);
        response.writeHead(202);
        response.end(
          JSON.stringify({
            ...(input as Record<string, unknown>),
            createdAt: 1,
            updatedAt: 1,
            status: "queued",
            cancelRequested: false,
            history: [],
            events: [queued],
          }),
        );
      });
    } else if (url.pathname.endsWith("/events")) {
      connections++;
      cursors.push(url.searchParams.get("after") ?? "0");
      response.setHeader("content-type", "application/x-ndjson");
      if (reconnectOnce) {
        reconnectOnce = false;
        response.end(`${JSON.stringify(queued)}\n`);
        return;
      }
      response.write(`${JSON.stringify(queued)}\n${JSON.stringify(waiting)}\n`);
      streams.add(response);
      response.on("close", () => {
        closed++;
        streams.delete(response);
      });
    } else if (url.pathname.endsWith("/decision")) {
      if (decisionFailure) {
        response.writeHead(409);
        response.end("{}");
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        decision = (JSON.parse(body) as { approved: boolean }).approved;
        response.end("{}");
        finish("completed");
      });
    } else if (url.pathname.endsWith("/cancel")) {
      if (cancelFailure) {
        response.writeHead(503);
        response.end("{}");
        return;
      }
      cancelRequested = true;
      response.end("{}");
      finish("cancelled");
    } else if (url.pathname.endsWith("/approvals/action")) {
      response.end(
        JSON.stringify({
          id: "action",
          preview: malicious,
          status: "pending",
          expiresAt: Date.now() + 60_000,
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          id: "run",
          profileId: "support",
          input: "Hello",
          createdAt: 1,
          updatedAt: 1,
          status: "awaiting_approval",
          cancelRequested: false,
          history: [],
          events: [queued, waiting],
        }),
      );
    }
    return;
  }
  const file = resolve(
    url.pathname.startsWith("/node_modules/")
      ? `.${url.pathname}`
      : `.${url.pathname.replace(/\.js$/, ".ts")}`,
  );
  void readFile(file, "utf8")
    .then((source) => {
      response.setHeader("content-type", "application/javascript");
      response.end(
        file.endsWith(".ts")
          ? ts.transpileModule(source, {
              compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
              },
            }).outputText
          : source,
      );
    })
    .catch(() => {
      response.writeHead(404);
      response.end();
    });
});
let browser: Browser;
let origin: string;
const open = async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  await page
    .locator("yada-chat")
    .first()
    .getByRole("button", { name: "Send", exact: true })
    .waitFor();
  return page;
};
const start = async (page: Page) => {
  const widget = page.locator("yada-chat").first();
  await widget.getByRole("textbox", { name: "Message" }).fill("Hello");
  await widget.getByRole("button", { name: "Send", exact: true }).click();
  return widget;
};

beforeAll(async () => {
  defineYadaWidget();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${String(address.port)}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
  for (const response of streams) response.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});
afterEach(async () => {
  for (const context of browser.contexts()) await context.close();
});
beforeEach(() => {
  decision = undefined;
  cancelRequested =
    reconnectOnce =
    createFailure =
    decisionFailure =
    cancelFailure =
      false;
  connections = closed = 0;
  cursors.length = inputs.length = 0;
});

describe("browser widget", () => {
  it("isolates two host themes and passes accessibility checks before and during approval", async () => {
    const page = await open();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const buttons = page
      .locator("yada-chat")
      .getByRole("button", { name: "Send", exact: true });
    expect(
      await buttons.evaluateAll((nodes) =>
        nodes.map((node) => [
          getComputedStyle(node).backgroundColor,
          getComputedStyle(node).borderRadius,
        ]),
      ),
    ).toEqual([
      ["rgb(29, 78, 216)", "18px"],
      ["rgb(190, 24, 93)", "0px"],
    ]);
    await page
      .locator("yada-chat")
      .first()
      .getByRole("textbox", { name: "Message" })
      .focus();
    await page.keyboard.type("Hello");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const widget = page.locator("yada-chat").first();
    await widget.getByRole("button", { name: "Approve action" }).waitFor();
    expect(await widget.getByRole("textbox").isDisabled()).toBe(true);
    expect(
      await widget
        .getByRole("button", { name: "Send", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(
      await widget
        .getByRole("button", { name: "Approve action" })
        .evaluate(
          (node) => node === (node.getRootNode() as ShadowRoot).activeElement,
        ),
    ).toBe(true);
    expect(await widget.getByRole("log").getAttribute("aria-live")).toBe(
      "polite",
    );
    expect(await widget.locator("pre").textContent()).toBe(malicious);
    expect(await widget.locator("img").count()).toBe(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Enter");
    await widget
      .getByRole("button", { name: "Send", exact: true })
      .waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        !document
          .querySelector("yada-chat")
          ?.shadowRoot?.querySelector("textarea")?.disabled,
    );
    expect(decision).toBe(true);
    expect(
      await page.evaluate(
        () => Reflect.get(globalThis, "compromised") as unknown,
      ),
    ).toBeUndefined();
    await page.close();
  });

  it("requires explicit decline and exposes cancellation without cancelling on disconnect", async () => {
    const page = await open();
    const widget = await start(page);
    await widget.getByRole("button", { name: "Decline action" }).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("yada-chat")
          ?.shadowRoot?.querySelector("textarea")?.disabled,
    );
    expect(decision).toBe(false);
    await widget.getByRole("textbox").fill("Second");
    await widget.getByRole("button", { name: "Send", exact: true }).click();
    await widget.getByRole("button", { name: "Approve action" }).waitFor();
    await page.evaluate(() => {
      document.querySelector("yada-chat")?.remove();
    });
    await expect.poll(() => closed).toBeGreaterThan(0);
    expect(cancelRequested).toBe(false);
    await page.close();
    const next = await open();
    const other = await start(next);
    await other.getByRole("button", { name: "Cancel run" }).click();
    await expect.poll(() => cancelRequested).toBe(true);
    await next.waitForFunction(
      () =>
        !document
          .querySelector("yada-chat")
          ?.shadowRoot?.querySelector("textarea")?.disabled,
    );
    expect(await other.getByRole("status").textContent()).toBe("cancelled");
    await next.close();
  });

  it("replays from the cursor across transport interruption and element reconnection", async () => {
    reconnectOnce = true;
    const page = await open();
    const widget = await start(page);
    await widget.getByRole("button", { name: "Approve action" }).waitFor();
    expect(cursors.slice(0, 2)).toEqual(["0", "1"]);
    expect(
      await widget
        .getByRole("log")
        .getByText(malicious, { exact: true })
        .count(),
    ).toBe(1);
    await page.evaluate(() => {
      const widget = document.querySelector("yada-chat");
      widget?.remove();
      if (widget) document.querySelector(".retail")?.append(widget);
    });
    await expect.poll(() => connections).toBe(3);
    await widget.getByRole("button", { name: "Approve action" }).waitFor();
    expect(cursors.at(-1)).toBe("2");
    expect(
      await widget
        .getByRole("log")
        .getByText(malicious, { exact: true })
        .count(),
    ).toBe(1);
    await widget.getByRole("button", { name: "Decline action" }).click();
    await page.close();
  });

  it("restores a host-persisted run into a fresh element", async () => {
    const page = await open();
    await page.evaluate(async () => {
      const widget = document.querySelector<YadaWidget>("yada-chat");
      await widget?.resume("saved-run");
    });
    const widget = page.locator("yada-chat").first();
    await widget.getByRole("button", { name: "Approve action" }).waitFor();
    expect(inputs).toHaveLength(0);
    expect(
      await widget
        .getByRole("log")
        .getByText("You: Hello", { exact: true })
        .count(),
    ).toBe(1);
    await widget.getByRole("button", { name: "Decline action" }).click();
    await page.close();
  });

  it("retries failed creation with the same id and reports failed decisions and cancellation", async () => {
    createFailure = true;
    const page = await open();
    const widget = await start(page);
    await widget
      .getByRole("button", { name: "Reconnect", exact: true })
      .waitFor();
    expect(inputs).toHaveLength(2);
    createFailure = false;
    await widget
      .getByRole("button", { name: "Reconnect", exact: true })
      .click();
    await widget.getByRole("button", { name: "Approve action" }).waitFor();
    expect(new Set(inputs).size).toBe(1);
    decisionFailure = true;
    await widget.getByRole("button", { name: "Approve action" }).click();
    await expect
      .poll(async () => widget.getByRole("alert").textContent())
      .toContain("Approval decision failed");
    cancelFailure = true;
    await widget.getByRole("button", { name: "Cancel run" }).click();
    await expect
      .poll(async () => widget.getByRole("alert").textContent())
      .toContain("Cancellation failed");
    await page.close();
  });
});
