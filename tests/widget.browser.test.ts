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
import {
  defineYadaWidget,
  type YadaWidget,
  type WidgetRunDetail,
} from "../src/widget/index.js";
import type { BrowserClient } from "../src/client/index.js";

declare global {
  interface Window {
    configureTestWidget: (widget: YadaWidget) => void;
    createTestClient: (baseUrl: string) => BrowserClient;
    finishedOperations: number;
  }
}

const malicious = '<img src=x onerror="globalThis.compromised=true">';
const reply = `**Done** with \`code\`\n\n- ${malicious}`;
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
let operationMode: "hold" | "terminal" | undefined;
let heldOperation: ServerResponse | undefined;
let holdRun = false;
let redirectTargetHits = 0;
let heldRun: ServerResponse | undefined;
let connections = 0;
let closed = 0;
const operationResponse = () => heldOperation;
const cursors: string[] = [];
const inputs: string[] = [];
const streams = new Set<ServerResponse>();
const finish = (type: string) => {
  for (const response of streams)
    response.end(
      `${JSON.stringify({ version: 1, sequence: 3, type, at: 1, text: reply })}\n`,
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
window.finishedOperations = 0;
window.createTestClient = baseUrl => {
  const client = new BrowserClient({baseUrl,reconnectDelayMs:5,maxRetries:1});
  for (const method of ['cancel','decide']) {
    const call = client[method].bind(client);
    client[method] = async (...args) => { try { await call(...args); } finally { window.finishedOperations++; } };
  }
  return client;
};
window.configureTestWidget = widget => widget.configure({client:window.createTestClient(location.origin+'/api'),conversationId:'chat',profileId:'support'});
for (const widget of document.querySelectorAll('yada-chat')) window.configureTestWidget(widget);
</script></body></html>`;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/") {
    response.setHeader("content-type", "text/html");
    response.end(html);
    return;
  }
  if (url.pathname.startsWith("/redirect/")) {
    response.writeHead(302, { location: "/api/redirect-target" });
    response.end();
    return;
  }
  if (url.pathname === "/api/redirect-target") redirectTargetHits++;
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
        if (operationMode) {
          heldOperation = response;
          if (operationMode === "terminal") finish("completed");
          return;
        }
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
      if (operationMode) {
        heldOperation = response;
        if (operationMode === "terminal") finish("cancelled");
        return;
      }
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
      if (holdRun) {
        heldRun = response;
        return;
      }
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
  heldOperation?.destroy();
  heldRun?.destroy();
  for (const context of browser.contexts()) await context.close();
});
beforeEach(() => {
  decision = undefined;
  operationMode = undefined;
  heldOperation = heldRun = undefined;
  holdRun = false;
  redirectTargetHits = 0;
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
    const log = widget.getByRole("log");
    expect(await log.locator(".assistant strong").last().textContent()).toBe(
      "Done",
    );
    expect(await log.locator(".assistant code").last().textContent()).toBe(
      "code",
    );
    expect(await log.locator(".assistant li").last().textContent()).toBe(
      malicious,
    );
    expect(await widget.locator("img").count()).toBe(0);
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
    await page.evaluate(() => {
      document.addEventListener("yada-run", (event) => {
        sessionStorage.setItem(
          "run",
          JSON.stringify((event as CustomEvent<WidgetRunDetail>).detail),
        );
      });
    });
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
    const saved: unknown = JSON.parse(
      await page.evaluate(() => sessionStorage.getItem("run") ?? "null"),
    );
    expect(saved).toEqual({
      conversationId: "chat",
      runId: (JSON.parse(inputs[0] ?? "null") as { id: string }).id,
    });
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
  it("keeps a newly configured run isolated from stale decision and cancellation callbacks", async () => {
    for (const operation of ["Cancel run", "Approve action"]) {
      operationMode = "hold";
      heldOperation = undefined;
      const page = await open();
      const widget = await start(page);
      await widget.getByRole("button", { name: "Approve action" }).waitFor();
      await widget.getByRole("button", { name: operation }).click();
      await expect.poll(() => heldOperation !== undefined).toBe(true);
      await page.evaluate(() => {
        const widget = document.querySelector<YadaWidget>("yada-chat");
        if (!widget) throw new Error("Missing widget");
        window.configureTestWidget(widget);
        const input = widget.shadowRoot?.querySelector("textarea");
        if (input) input.value = "New conversation";
        widget.shadowRoot
          ?.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.click();
      });
      await widget.getByRole("button", { name: "Approve action" }).waitFor();
      expect(await widget.getByRole("alert").textContent()).toBe("");
      expect(await widget.getByRole("status").textContent()).toBe(
        "awaiting approval",
      );
      expect(
        await widget.getByRole("button", { name: "Cancel run" }).isDisabled(),
      ).toBe(false);
      operationResponse()?.end("{}");
      await page.close();
    }
  });

  it.each(
    ["Cancel run", "Approve action"].flatMap((operation) =>
      [200, 409].map((status) => ({ operation, status })),
    ),
  )(
    "preserves terminal state when $operation settles with HTTP $status",
    async ({ operation, status }) => {
      operationMode = "terminal";
      const page = await open();
      const widget = await start(page);
      await widget.getByRole("button", { name: "Approve action" }).waitFor();
      await widget.getByRole("button", { name: operation }).click();
      const terminal = operation === "Cancel run" ? "cancelled" : "completed";
      await expect
        .poll(async () => widget.getByRole("status").textContent())
        .toBe(terminal);
      const response = operationResponse();
      if (!response) throw new Error("Missing held response");
      const settled = page.waitForResponse((response) =>
        response
          .url()
          .endsWith(operation === "Cancel run" ? "/cancel" : "/decision"),
      );
      response.writeHead(status);
      response.end("{}");
      expect((await settled).status()).toBe(status);
      await page.waitForFunction(() => window.finishedOperations > 0);
      expect(await widget.getByRole("status").textContent()).toBe(terminal);
      expect(await widget.getByRole("alert").textContent()).toBe("");
      expect(await widget.getByRole("textbox").isDisabled()).toBe(false);
      await page.close();
    },
  );

  it("rejects API redirects without following their target", async () => {
    const page = await open();
    expect(
      await page.evaluate(() =>
        window
          .createTestClient(location.origin + "/redirect")
          .getRun("chat", "run")
          .then(
            () => false,
            () => true,
          ),
      ),
    ).toBe(true);
    expect(redirectTargetHits).toBe(0);
    await page.close();
  });

  it("disables submission while a saved run loads and recovers on loading errors", async () => {
    holdRun = true;
    const page = await open();
    const widget = page.locator("yada-chat").first();
    await page.evaluate(() => {
      const widget = document.querySelector<YadaWidget>("yada-chat");
      void widget?.resume("saved-run").catch(() => undefined);
    });
    await expect.poll(() => heldRun !== undefined).toBe(true);
    expect(await widget.getByRole("textbox").isDisabled()).toBe(true);
    expect(
      await widget
        .getByRole("button", { name: "Send", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(
      await widget.getByRole("button", { name: "Cancel run" }).isVisible(),
    ).toBe(false);
    heldRun?.writeHead(503);
    heldRun?.end("{}");
    await expect
      .poll(async () => widget.getByRole("textbox").isDisabled())
      .toBe(false);
    expect(await widget.getByRole("alert").textContent()).toBe(
      "Could not load the saved run.",
    );
    expect(inputs).toHaveLength(0);
    await page.close();
  });
});
