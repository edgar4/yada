import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { widgetParts } from "../src/widget/parts.js";
import { cssVariables, defaultStyles } from "../src/widget/styles.js";
import type { BrowserClient, RunEvent } from "../src/client/index.js";
import type {
  WidgetOptions,
  YadaWidget,
  defineYadaWidget,
} from "../src/widget/index.js";

type Script = Readonly<{
  events?: readonly (Omit<RunEvent, "version"> & { version: number })[];
  hang?: boolean;
  timeoutMs?: number;
  preview?: string;
  approval?: Readonly<{ expiresAt: number }>;
  runStatus?: number;
  eventsStatus?: number;
}>;
declare global {
  const Yada: Readonly<{
    defineYadaWidget: typeof defineYadaWidget;
    widgetExportParts: string;
  }>;
  const mock: (script?: Script) => BrowserClient;
  const make: (
    options?: Partial<WidgetOptions>,
    script?: Script,
    attributes?: Readonly<Record<string, string>>,
    children?: string,
  ) => YadaWidget;
  interface Window {
    waiting: NonNullable<Script["events"]>;
    calls: string[];
    seen: [string, unknown][];
    released?: boolean;
    compromised?: boolean;
    container?: ParentNode | null;
    widget?: YadaWidget;
  }
}

const harness = `
window.waiting = [
  { version: 1, sequence: 1, type: "queued", at: 1 },
  { version: 1, sequence: 2, type: "awaiting_approval", at: 1, approvalId: "a" },
];
window.calls = [];
window.seen = [];
window.mock = (script = {}) =>
  new Yada.BrowserClient({
    baseUrl: "http://localhost:1",
    reconnectDelayMs: 0,
    maxRetries: 0,
    ...(script.timeoutMs === undefined ? {} : { timeoutMs: script.timeoutMs }),
    fetch: async (url, init) => {
      const path = String(url);
      window.calls.push(init.method + " " + path);
      const hang = () => new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")));
      });
      if (script.hang && !window.released) return hang();
      if (path.endsWith("/decision") || path.endsWith("/cancel") || path.endsWith("/messages"))
        return Response.json({ accepted: true }, { status: 202 });
      if (path.includes("/approvals/"))
        return Response.json({
          id: "a",
          preview: script.preview ?? "firstName: Testy",
          status: "pending",
          expiresAt: Date.now() + 60000,
          ...(script.approval ?? {}),
        });
      if (path.includes("/events?")) {
        if (script.eventsStatus) return new Response("{}", { status: script.eventsStatus });
        const after = Number(new URL(path).searchParams.get("after"));
        const lines = (script.events ?? window.waiting)
          .filter((event) => event.sequence > after || event.type === "text_delta")
          .map((event) => JSON.stringify(event) + "\\n")
          .join("");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(lines));
              init.signal?.addEventListener("abort", () => controller.error(new Error("closed")));
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      if (script.runStatus && init.method === "GET") return new Response("{}", { status: script.runStatus });
      const input = init.body ? JSON.parse(init.body) : { id: "run", profileId: "p", input: "Hello" };
      return Response.json({
        ...input, createdAt: 1, updatedAt: 1, status: "queued", cancelRequested: false,
        history: script.history ?? [], steering: [], events: [],
      }, { status: init.method === "POST" ? 202 : 200 });
    },
  });
window.make = (options = {}, script = {}, attributes = {}, children = "") => {
  const element = document.createElement("yada-chat");
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.innerHTML = children;
  for (const type of ["yada-ready", "yada-run", "yada-message", "yada-approval", "yada-approval-decided", "yada-error", "yada-run-end"])
    element.addEventListener(type, (event) => window.seen.push([type, event.detail]));
  element.configure({ client: window.mock(script), conversationId: "c", profileId: "p", ...options });
  (window.container ?? document.body).append(element);
  window.widget = element;
  return element;
};
`;
let bundle = "";
let browser: Browser;
const open = async (body = "") => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("http://localhost:1/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><title>Theming</title></head><body><main><h1>Host</h1>${body}</main></body></html>`,
    }),
  );
  await page.goto("http://localhost:1/");
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: harness });
  await page.evaluate(() => {
    Yada.defineYadaWidget();
    window.container = document.querySelector("main");
  });
  return page;
};
const send = async (page: Page, text = "Hello") => {
  const widget = page.locator("yada-chat");
  await widget.getByRole("textbox").fill(text);
  await widget.getByRole("textbox").press("Enter");
  return widget;
};
const style = (page: Page, selector: string, property: string) =>
  page.evaluate(
    ([target, name]) =>
      getComputedStyle(
        document
          .querySelector("yada-chat")
          ?.shadowRoot?.querySelector(target ?? "") as Element,
      ).getPropertyValue(name ?? ""),
    [selector, property],
  );
const audit = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((item) => item.id)).toEqual([]);
};

beforeAll(async () => {
  const output = await build({
    stdin: {
      contents:
        'export * from "./src/client/index.ts"; export * from "./src/widget/index.ts";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "Yada",
    target: "es2022",
    write: false,
  });
  bundle = output.outputFiles[0]?.text ?? "";
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  for (const context of browser.contexts()) await context.close();
});

describe("name and identity", () => {
  it("defaults to Yada's name and face, and hides them on request", async () => {
    const page = await open();
    await page.evaluate(() => make({ labels: { send: "Ask {name}" } }));
    const widget = page.locator("yada-chat");
    expect(await widget.locator("h2").textContent()).toBe("Yada");
    expect(await widget.getByRole("textbox").getAttribute("placeholder")).toBe(
      "Message Yada",
    );
    await widget.getByRole("button", { name: "Ask Yada" }).waitFor();
    await widget.locator('[part="avatar"] .face').waitFor();
    await widget.locator('[part="empty-avatar"] .face').waitFor();
    expect(await widget.locator('[part="subtitle"]').isHidden()).toBe(true);
    const plain = await open();
    await plain.evaluate(() => make({ avatar: false }));
    const hidden = plain.locator("yada-chat");
    expect(await hidden.locator('[part="avatar"]').isHidden()).toBe(true);
    expect(await hidden.locator('[part="empty-avatar"]').isHidden()).toBe(true);
  });

  it("changes her face with the run", async () => {
    const page = await open();
    await page.evaluate(() => make());
    const widget = page.locator("yada-chat");
    const mood = () => widget.getAttribute("data-mood");
    expect(await mood()).toBe("neutral");
    await widget.getByRole("textbox").fill("Hello");
    await widget.getByRole("button", { name: "Send" }).click();
    await expect.poll(mood).toBe("wink");
    const done = await open();
    await done.evaluate(() =>
      make(
        {},
        {
          events: [
            { version: 1, sequence: 1, type: "completed", at: 1, text: "Hi" },
          ],
        },
      ),
    );
    const replied = done.locator("yada-chat");
    await replied.getByRole("textbox").fill("Hello");
    await replied.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => replied.getAttribute("data-mood")).toBe("smile");
  });

  it("uses the name everywhere she is named, from option or attribute", async () => {
    const page = await open();
    await page.evaluate(() => make({ name: "Juno", subtitle: "Support" }));
    const widget = page.locator("yada-chat");
    expect(await widget.locator("h2").textContent()).toBe("Juno");
    expect(await widget.locator('[part="subtitle"]').textContent()).toBe(
      "Support",
    );
    expect(await widget.getByRole("textbox").getAttribute("placeholder")).toBe(
      "Message Juno",
    );
    await widget.getByRole("textbox", { name: "Message Juno" }).waitFor();
    await widget.getByRole("log", { name: "Conversation with Juno" }).waitFor();
    expect(await widget.locator('[part="empty-text"]').textContent()).toBe(
      "Send Juno a message to start the conversation.",
    );

    await page.evaluate(() => {
      window.widget?.remove();
      make({}, {}, { name: "Pip" });
    });
    expect(await widget.locator("h2").textContent()).toBe("Pip");
    await page.evaluate(() => window.widget?.setAttribute("name", "Bo"));
    expect(await widget.locator("h2").textContent()).toBe("Bo");
  });

  it("renders text, image and slotted avatars, and rejects script URLs", async () => {
    const page = await open();
    await page.evaluate(() => make({ avatar: { text: "Y" } }));
    const avatar = page.locator("yada-chat").locator('[part="avatar"]');
    expect(await avatar.textContent()).toBe("Y");
    await page.evaluate(() => {
      window.widget?.configure({
        client: mock(),
        conversationId: "c",
        profileId: "p",
        avatar: { image: "https://example.test/a.png" },
      });
    });
    expect(await avatar.locator("img").getAttribute("src")).toBe(
      "https://example.test/a.png",
    );
    expect(await avatar.locator("img").getAttribute("alt")).toBe("");
    await page.evaluate(() => {
      window.widget?.configure({
        client: mock(),
        conversationId: "c",
        profileId: "p",
        avatar: { image: "javascript:alert(1)" },
      });
    });
    expect(await avatar.locator("img").count()).toBe(0);
    await page.evaluate(() => {
      window.widget?.remove();
      make({}, {}, {}, '<b slot="avatar">S</b>');
    });
    await page.waitForFunction(
      () =>
        !window.widget?.shadowRoot?.querySelector<HTMLElement>(
          '[part="avatar"]',
        )?.hidden,
    );
  });

  it("hides the header while keeping an accessible name", async () => {
    const page = await open();
    await page.evaluate(() => make({ name: "Juno", header: false }));
    const widget = page.locator("yada-chat");
    expect(await widget.locator("header").isHidden()).toBe(true);
    expect(
      await widget.locator('[part="root"]').getAttribute("aria-label"),
    ).toBe("Juno");
    await audit(page);
  });
});

describe("parts and state", () => {
  it("exposes every documented part across the widget's states", async () => {
    const page = await open();
    await page.evaluate(() => {
      make(
        {
          avatar: { text: "Y" },
          subtitle: "Hi",
          suggestions: ["One"],
          renderActivity: (activity) => activity.tool,
        },
        {
          events: [
            ...window.waiting,
            { version: 1, sequence: 3, type: "tool_started", at: 1, tool: "x" },
          ],
        },
      );
    });
    const found = new Set<string>();
    const collect = async () => {
      const names = await page.evaluate(() =>
        [
          ...(window.widget?.shadowRoot?.querySelectorAll("[part]") ?? []),
        ].flatMap((node) => [...node.part]),
      );
      for (const name of names) found.add(name);
    };
    await collect();
    const widget = await send(page, "Hello");
    await widget.locator('[part~="user"]').waitFor();
    await page.waitForFunction(() =>
      window.widget?.shadowRoot?.querySelector('[part="activity"]'),
    );
    await collect();
    await page.evaluate(() => {
      window.widget?.remove();
      make(
        {},
        {
          events: [
            {
              version: 1,
              sequence: 1,
              type: "completed",
              at: 1,
              text: "**a** `code`\n```\nblock\n```",
            },
          ],
        },
      );
    });
    await send(page);
    await page.locator("yada-chat").locator('[part="code-block"]').waitFor();
    await collect();
    const missing = widgetParts.filter((name) => !found.has(name));
    expect(missing).toEqual([]);
    const unknown = [...found].filter(
      (name) => !(widgetParts as readonly string[]).includes(name),
    );
    expect(unknown).toEqual([]);
  });

  it("styles parts from outside and forwards them through a wrapper", async () => {
    const page = await open();
    await page.evaluate(() => {
      const host = document.createElement("div");
      document.querySelector("main")?.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = "#w::part(send){letter-spacing:3px}";
      shadow.append(style);
      window.container = shadow;
      const element = make();
      element.id = "w";
      const outer = document.createElement("style");
      outer.textContent = "#host::part(title){letter-spacing:7px}";
      document.head.append(outer);
      host.id = "host";
      element.setAttribute("exportparts", Yada.widgetExportParts);
    });
    const spacing = await page.evaluate(() => {
      const shadow = document.querySelector("#host")?.shadowRoot;
      const inner = shadow?.querySelector("yada-chat")?.shadowRoot;
      const read = (selector: string) =>
        getComputedStyle(inner?.querySelector(selector) as Element)
          .letterSpacing;
      return [read('[part="send"]'), read('[part="title"]')];
    });
    expect(spacing).toEqual(["3px", "7px"]);
  });

  it("reflects state and connection on the host", async () => {
    const page = await open();
    await page.evaluate(() => make());
    const widget = page.locator("yada-chat");
    const read = () =>
      page.evaluate(() => [
        window.widget?.dataset["state"],
        window.widget?.dataset["connection"],
      ]);
    expect(await read()).toEqual(["idle", "connected"]);
    await send(page);
    await widget.getByRole("button", { name: "Approve action" }).waitFor();
    expect(await read()).toEqual(["awaiting-approval", "connected"]);
    await page.evaluate(() => {
      window.widget?.remove();
      make({}, { hang: true });
    });
    await send(page);
    await page.waitForFunction(
      () => window.widget?.dataset["state"] === "running",
    );
    expect(await read()).toEqual(["running", "connected"]);
    await page.evaluate(() => {
      window.widget?.remove();
      make(
        {},
        {
          events: [
            { version: 1, sequence: 1, type: "failed", at: 1, code: "limit" },
          ],
        },
      );
    });
    await send(page);
    await page.waitForFunction(
      () => window.widget?.dataset["state"] === "error",
    );
  });
});

describe("styling", () => {
  it("defaults approve to green, decline to red, both overridable", async () => {
    const page = await open();
    await page.evaluate(() => make());
    await send(page);
    await page
      .locator("yada-chat")
      .getByRole("button", { name: "Approve action" })
      .waitFor();
    expect(await style(page, ".approve", "background-color")).toBe(
      "rgb(21, 128, 61)",
    );
    expect(await style(page, ".decline", "background-color")).toBe(
      "rgb(185, 28, 28)",
    );
    await audit(page);
    await page.evaluate(() => {
      window.widget?.style.setProperty("--yada-approve", "rgb(1, 2, 3)");
      window.widget?.style.setProperty("--yada-decline", "rgb(4, 5, 6)");
    });
    expect(await style(page, ".approve", "background-color")).toBe(
      "rgb(1, 2, 3)",
    );
    expect(await style(page, ".decline", "background-color")).toBe(
      "rgb(4, 5, 6)",
    );
  });

  it("applies every documented variable in the default sheet", () => {
    for (const name of cssVariables)
      expect(
        defaultStyles.includes(`${name},`) ||
          defaultStyles.includes(`var(--_${name.slice(7)}`),
      ).toBe(true);
  });

  it("applies a styles string or sheet after the defaults", async () => {
    const page = await open();
    await page.evaluate(() => make({ styles: "h2 { color: rgb(9, 8, 7); }" }));
    expect(await style(page, "h2", "color")).toBe("rgb(9, 8, 7)");
    expect(await style(page, "section", "display")).toBe("flex");
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("h2 { color: rgb(1, 1, 1); }");
      window.widget?.configure({
        client: mock(),
        conversationId: "c",
        profileId: "p",
        styles: sheet,
      });
    });
    expect(await style(page, "h2", "color")).toBe("rgb(1, 1, 1)");
  });

  it("drops the defaults when unstyled but keeps accessibility intact", async () => {
    const page = await open();
    await page.evaluate(() => make({ unstyled: true }));
    expect(await style(page, "section", "display")).toBe("block");
    expect(await style(page, '[role="status"]', "position")).toBe("absolute");
    expect(await style(page, "form > label", "position")).toBe("absolute");
    expect(await style(page, '[role="group"]', "display")).toBe("none");
    await send(page);
    await page
      .locator("yada-chat")
      .getByRole("button", { name: "Approve action" })
      .waitFor();
    await audit(page);
  });

  it("supports dark mode through the attribute and prefers-color-scheme", async () => {
    const page = await open();
    await page.evaluate(() => make({ colorScheme: "dark" }));
    expect(await style(page, "section", "background-color")).toBe(
      "rgb(14, 14, 18)",
    );
    await audit(page);
    await page.evaluate(() => {
      window.widget?.style.setProperty("--yada-log-background", "rgb(3, 3, 3)");
    });
    expect(await style(page, "section", "background-color")).toBe(
      "rgb(3, 3, 3)",
    );
    await page.evaluate(() => {
      window.widget?.remove();
      make({ colorScheme: "auto" });
    });
    await page.emulateMedia({ colorScheme: "light" });
    expect(await style(page, "section", "background-color")).toBe(
      "rgb(242, 242, 244)",
    );
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await style(page, "section", "background-color")).toBe(
      "rgb(14, 14, 18)",
    );
    await page.evaluate(() => {
      window.widget?.remove();
      make();
    });
    expect(await style(page, "section", "background-color")).toBe(
      "rgb(242, 242, 244)",
    );
  });

  it("stops the typing animation under reduced motion", async () => {
    const page = await open();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => make());
    expect(await style(page, ".typing span", "animation-name")).toBe("none");
  });
});

describe("layout and composer", () => {
  it("keeps the 360px log unless asked to fill", async () => {
    const page = await open('<div id="box" style="height:600px"></div>');
    await page.evaluate(() => {
      window.container = document.querySelector("#box");
      make();
    });
    const height = () =>
      page.evaluate(
        () =>
          window.widget?.shadowRoot
            ?.querySelector(".log")
            ?.getBoundingClientRect().height,
      );
    expect(await height()).toBe(360);
  });

  it("fills its container, scrolls the log and keeps the composer in view", async () => {
    const page = await open('<div id="box" style="height:500px"></div>');
    await page.evaluate(() => {
      window.container = document.querySelector("#box");
      make({
        fill: true,
        name: "Juno",
        suggestions: [],
      });
    });
    const widget = await send(page, "A\n".repeat(200));
    await widget.locator(".user").waitFor();
    const geometry = await page.evaluate(() => {
      const host = window.widget as HTMLElement;
      const log = host.shadowRoot?.querySelector(".log") as HTMLElement;
      const form = host.shadowRoot?.querySelector("form") as HTMLElement;
      return {
        host: host.getBoundingClientRect().height,
        formBottom: form.getBoundingClientRect().bottom,
        hostBottom: host.getBoundingClientRect().bottom,
        scrolls: log.scrollHeight > log.clientHeight,
      };
    });
    expect(geometry.host).toBe(500);
    expect(geometry.formBottom).toBeLessThanOrEqual(geometry.hostBottom);
    expect(geometry.scrolls).toBe(true);
    await page.evaluate(() => {
      window.widget?.remove();
      make({}, {}, { fill: "" });
    });
    expect(
      await page.evaluate(() => window.widget?.getBoundingClientRect().height),
    ).toBe(500);
  });

  it("offers icon send with an accessible name and a slot", async () => {
    const page = await open();
    await page.evaluate(() => make({ composer: { send: "icon" } }));
    const widget = page.locator("yada-chat");
    const button = widget.getByRole("button", { name: "Send", exact: true });
    await button.waitFor();
    expect(await button.textContent()).toBe("");
    expect(await button.locator("svg").count()).toBe(1);
    await audit(page);
    await page.evaluate(() => {
      window.widget?.remove();
      make({ composer: { send: "icon" } }, {}, {}, '<i slot="send-icon">→</i>');
    });
    const assigned = await page.evaluate(
      () =>
        window.widget?.shadowRoot
          ?.querySelector<HTMLSlotElement>('slot[name="send-icon"]')
          ?.assignedNodes().length,
    );
    expect(assigned).toBe(1);
  });

  it("auto-grows the input and shrinks it after sending", async () => {
    const page = await open();
    await page.evaluate(() => make({ composer: { autoGrow: true } }));
    const widget = page.locator("yada-chat");
    const input = widget.getByRole("textbox");
    const height = () =>
      input.evaluate((node) => node.getBoundingClientRect().height);
    const start = await height();
    await input.fill("a\nb\nc\nd");
    expect(await height()).toBeGreaterThan(start);
    await input.fill("a\n".repeat(50));
    expect(await height()).toBe(160);
    await input.press("Enter");
    await page.waitForFunction(
      () => !window.widget?.shadowRoot?.querySelector("textarea")?.value,
    );
    expect(await height()).toBe(start);
  });

  it("switches Enter between send and newline", async () => {
    const page = await open();
    await page.evaluate(() => make({ composer: { enter: "newline" } }));
    const input = page.locator("yada-chat").getByRole("textbox");
    await input.fill("one");
    await input.press("Enter");
    expect(await input.inputValue()).toBe("one\n");
    await input.press("Control+Enter");
    expect(await input.inputValue()).toBe("");
  });

  it("fills the header, empty, above-composer and footer slots", async () => {
    const page = await open();
    await page.evaluate(() =>
      make(
        {},
        {},
        {},
        '<div slot="header" id="h">H</div><div slot="empty" id="e">E</div><div slot="above-composer" id="a">A</div><div slot="footer" id="f">F</div>',
      ),
    );
    for (const id of ["h", "e", "a", "f"])
      expect(await page.locator(`#${id}`).isVisible()).toBe(true);
    expect(await page.locator("yada-chat h2").isVisible()).toBe(false);
    await send(page);
    await page.locator("yada-chat .user").waitFor();
    expect(await page.locator("#e").isVisible()).toBe(false);
  });
});

describe("hooks", () => {
  it("renders messages through a hook without letting markup through", async () => {
    const page = await open();
    await page.evaluate(() =>
      make(
        {
          renderMessage: (message, helpers) => {
            const box = document.createElement("div");
            box.className = "custom";
            const script = document.createElement("script");
            script.textContent = "window.compromised = true";
            const link = document.createElement("a");
            link.href = "javascript:window.compromised=true";
            link.setAttribute("onclick", "window.compromised=true");
            link.textContent = "link";
            box.append(helpers.markdown(message.text), script, link);
            return box;
          },
        },
        {
          events: [
            {
              version: 1,
              sequence: 1,
              type: "completed",
              at: 1,
              text: '<img src=x onerror="window.compromised=true"> **bold**',
            },
          ],
        },
      ),
    );
    await send(page, "<b>hi</b>");
    const widget = page.locator("yada-chat");
    await widget.locator(".assistant .custom").waitFor();
    expect(await widget.locator(".user .speaker").textContent()).toBe("You: ");
    expect(await widget.locator(".custom script").count()).toBe(0);
    expect(await widget.locator(".custom img").count()).toBe(0);
    expect(
      await widget.locator(".assistant .custom strong").textContent(),
    ).toBe("bold");
    const link = widget.locator(".assistant .custom a");
    expect(await link.getAttribute("href")).toBeNull();
    expect(await link.getAttribute("onclick")).toBeNull();
    await link.click();
    expect(await page.evaluate(() => window.compromised)).toBeUndefined();
  });

  it("falls back to the default and reports when a hook throws", async () => {
    const page = await open();
    await page.evaluate(() =>
      make({
        renderMessage: () => {
          throw new Error("boom");
        },
      }),
    );
    await send(page);
    const widget = page.locator("yada-chat");
    await widget.locator(".user", { hasText: "Hello" }).waitFor();
    const errors = await page.evaluate(() =>
      window.seen.filter(([type]) => type === "yada-error"),
    );
    expect(errors[0]?.[1]).toMatchObject({ kind: "render", message: "boom" });
  });

  it("formats the approval preview as text and falls back on failure", async () => {
    const page = await open();
    await page.evaluate(() =>
      make({
        formatApprovalPreview: (preview) =>
          preview.replace("firstName:", "First name is"),
      }),
    );
    await send(page);
    const widget = page.locator("yada-chat");
    await widget.getByText("First name is Testy").waitFor();
    await page.evaluate(() => {
      window.widget?.remove();
      make({
        formatApprovalPreview: () => {
          throw new Error("nope");
        },
      });
    });
    await send(page);
    await widget.getByText("firstName: Testy").waitFor();
  });

  it("renders a custom approval card with safe actions and focus", async () => {
    const page = await open();
    await page.evaluate(() =>
      make({
        renderApproval: (approval, actions) => {
          const button = document.createElement("button");
          button.textContent = "Yes please";
          button.addEventListener("click", () => {
            actions.approve({ remember: true });
          });
          const box = document.createElement("div");
          box.append(approval.preview, button);
          return box;
        },
      }),
    );
    await send(page);
    const widget = page.locator("yada-chat");
    const button = widget.getByRole("button", { name: "Yes please" });
    await button.waitFor();
    await widget.getByRole("group", { name: "Action approval" }).waitFor();
    expect(
      await page.evaluate(
        () => window.widget?.shadowRoot?.activeElement?.textContent,
      ),
    ).toBe("Yes please");
    await button.click();
    await page.waitForFunction(() =>
      window.seen.some(([type]) => type === "yada-approval-decided"),
    );
    expect(
      await page.evaluate(
        () =>
          window.seen.find(([type]) => type === "yada-approval-decided")?.[1],
      ),
    ).toMatchObject({ approved: true, remember: true, approvalId: "a" });
  });

  it("refuses to decide an expired approval through a custom card", async () => {
    const page = await open();
    await page.evaluate(() =>
      make(
        {
          renderApproval: (_, actions) => {
            const button = document.createElement("button");
            button.textContent = "Force";
            button.addEventListener("click", () => {
              actions.approve();
            });
            return button;
          },
        },
        { approval: { expiresAt: 1 } },
      ),
    );
    await send(page);
    await page
      .locator("yada-chat")
      .getByRole("button", { name: "Force" })
      .click();
    expect(
      await page.evaluate(() =>
        window.calls.some((call) => call.endsWith("/decision")),
      ),
    ).toBe(false);
  });

  it("shows tool activity through a hook and clears it", async () => {
    const page = await open();
    await page.evaluate(() =>
      make(
        {
          renderActivity: (activity) => `${activity.phase}: ${activity.tool}`,
        },
        {
          events: [
            {
              version: 1,
              sequence: 1,
              type: "tool_started",
              at: 1,
              tool: "search",
            },
          ],
        },
      ),
    );
    await send(page);
    const activity = page.locator("yada-chat").locator('[part="activity"]');
    await activity.getByText("started: search").waitFor();
    await page.evaluate(() => {
      window.widget?.remove();
      make(
        { renderActivity: (activity) => activity.tool },
        {
          events: [
            {
              version: 1,
              sequence: 1,
              type: "tool_started",
              at: 1,
              tool: "search",
            },
            { version: 1, sequence: 2, type: "completed", at: 1, text: "Done" },
          ],
        },
      );
    });
    await send(page);
    await page.locator("yada-chat .assistant").waitFor();
    expect(await activity.isHidden()).toBe(true);
  });

  it("sends a suggestion and hides them once the chat starts", async () => {
    const page = await open();
    await page.evaluate(() =>
      make(
        {
          suggestions: [
            "Track my order",
            { label: "Returns", text: "How do returns work?" },
          ],
        },
        { events: [] },
      ),
    );
    const widget = page.locator("yada-chat");
    await audit(page);
    await widget.getByRole("button", { name: "Returns" }).click();
    await widget
      .locator(".user", { hasText: "How do returns work?" })
      .waitFor();
    expect(
      await widget.getByRole("button", { name: "Track my order" }).count(),
    ).toBe(0);
    expect(
      await page.evaluate(() => window.widget?.shadowRoot?.activeElement?.id),
    ).toBe("message");
  });
});

describe("events and failures", () => {
  it("emits the lifecycle events with details", async () => {
    const page = await open();
    await page.evaluate(() => make());
    const widget = await send(page);
    await widget.getByRole("button", { name: "Approve action" }).click();
    await page.waitForFunction(() =>
      window.seen.some(([type]) => type === "yada-approval-decided"),
    );
    const seen = await page.evaluate(() => window.seen);
    expect(seen.map(([type]) => type)).toEqual([
      "yada-ready",
      "yada-run",
      "yada-message",
      "yada-approval",
      "yada-approval-decided",
    ]);
    expect(seen[0]?.[1]).toEqual({ conversationId: "c" });
    expect(seen[2]?.[1]).toMatchObject({ text: "Hello", steering: false });
    expect(seen[3]?.[1]).toMatchObject({
      approvalId: "a",
      preview: "firstName: Testy",
    });
  });

  it("reports a failed run with its readable text and code", async () => {
    const page = await open();
    await page.evaluate(() =>
      make(
        {},
        {
          events: [
            {
              version: 1,
              sequence: 1,
              type: "failed",
              at: 1,
              code: "corrupt_record",
            },
          ],
        },
      ),
    );
    await send(page);
    const widget = page.locator("yada-chat");
    await widget
      .getByRole("alert")
      .getByText("saved data was damaged")
      .waitFor();
    expect(
      await page.evaluate(
        () => window.seen.find(([type]) => type === "yada-error")?.[1],
      ),
    ).toMatchObject({ kind: "run", code: "corrupt_record" });
  });

  it("clears quietly when a resumed run no longer exists", async () => {
    const page = await open();
    const result = await page.evaluate(async () => {
      const element = make({}, { runStatus: 404 });
      return element.resume("gone").then(
        () => "resolved",
        (error: unknown) => [
          (error as Error).name,
          (error as { status?: number }).status,
        ],
      );
    });
    expect(result).toEqual(["ClientError", 404]);
    const widget = page.locator("yada-chat");
    expect(await widget.getByRole("alert").textContent()).toBe("");
    await widget.getByText("Send a message to start").waitFor();
    expect(await widget.locator(".typing").isHidden()).toBe(true);
    expect(
      await widget.getByRole("button", { name: "Reconnect" }).count(),
    ).toBe(0);
    expect(await page.evaluate(() => window.widget?.dataset["state"])).toBe(
      "idle",
    );
    expect(
      await page.evaluate(() =>
        window.seen.some(([type]) => type === "yada-error"),
      ),
    ).toBe(false);
  });

  it("clears quietly when a run vanishes after it was loaded", async () => {
    const page = await open();
    await page.evaluate(() => {
      void make({}, { eventsStatus: 404 }).resume("run");
    });
    const widget = page.locator("yada-chat");
    await widget.getByText("Send a message to start").waitFor();
    expect(await widget.locator(".user").count()).toBe(0);
    expect(await widget.getByRole("alert").textContent()).toBe("");
  });

  it("keeps the load error for real failures and reports it", async () => {
    const page = await open();
    const result = await page.evaluate(async () => {
      const element = make({}, { runStatus: 400 });
      return element.resume("run").then(
        () => "resolved",
        (error: unknown) => (error as { status?: number }).status,
      );
    });
    expect(result).toBe(400);
    await page
      .locator("yada-chat")
      .getByRole("alert")
      .getByText("Could not load the saved run.")
      .waitFor();
  });

  it("stops the typing dots and offers a retry when the agent is unreachable", async () => {
    const page = await open();
    await page.evaluate(() => make({}, { hang: true, timeoutMs: 50 }));
    const widget = await send(page);
    const alert = widget.getByRole("alert");
    await alert.getByText("Connection failed").waitFor();
    expect(await widget.locator(".typing").isHidden()).toBe(true);
    expect(
      await page.evaluate(() => window.widget?.dataset["connection"]),
    ).toBe("disconnected");
    const retry = widget.getByRole("button", { name: "Reconnect" });
    await page.evaluate(() => {
      window.released = true;
    });
    await retry.click();
    await widget.getByRole("button", { name: "Approve action" }).waitFor();
    expect(await alert.textContent()).toBe("");
    expect(
      await page.evaluate(() => window.widget?.dataset["connection"]),
    ).toBe("connected");
  });
});

describe("theming guide", () => {
  it("documents every part, variable, slot, event and label change", async () => {
    const guide = await readFile("docs/theming.md", "utf8");
    const browserGuide = await readFile("docs/browser.md", "utf8");
    for (const name of [
      ...widgetParts,
      ...cssVariables,
      "above-composer",
      "send-icon",
      "yada-ready",
      "yada-run",
      "yada-run-end",
      "yada-message",
      "yada-approval",
      "yada-approval-decided",
      "yada-error",
      "renderMessage",
      "renderApproval",
      "renderActivity",
      "formatApprovalPreview",
      "suggestions",
      "unstyled",
      "colorScheme",
      "composer.autoGrow",
      "composer.send",
      "composer.enter",
      "data-state",
      "data-connection",
    ])
      expect(guide, name).toContain(`\`${name}\``);
    const labels = /`errorCorruptRecord`/.test(browserGuide);
    expect(labels).toBe(true);
  });
});
