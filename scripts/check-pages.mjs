import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "work/pages");
const files = (await readdir(output)).filter((name) => name.endsWith(".html"));
assert(files.includes("index.html"));
assert.equal(
  await readFile(join(output, "CNAME"), "utf8"),
  await readFile(join(root, "docs/CNAME"), "utf8"),
);
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".svg": "image/svg+xml",
};
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const target = resolve(
    output,
    `.${path.endsWith("/") ? `${path}index.html` : path}`,
  );
  if (!target.startsWith(output + sep)) {
    response.writeHead(403).end();
    return;
  }
  void readFile(target)
    .then((data) => {
      response
        .writeHead(200, {
          "content-type": mime[extname(target)] ?? "application/octet-stream",
        })
        .end(data);
    })
    .catch(() => response.writeHead(404).end());
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const failures = [];
const links = new Set();
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(error.message));
    for (const name of files) {
      const response = await page.goto(`${base}/${name}`);
      assert.equal(response.status(), 200, name);
      assert.deepEqual(failures, [], `${name}: browser errors`);
      assert.equal(await page.locator("h1").count(), 1, `${name}: one h1`);
      assert.equal(await page.locator("main").count(), 1, `${name}: one main`);
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth <=
            globalThis.innerWidth,
        ),
        true,
        `${name}: horizontal overflow at ${viewport.width}`,
      );
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      assert.deepEqual(
        result.violations.map(({ id, nodes }) => ({
          id,
          nodes: nodes.map((node) => node.target),
        })),
        [],
        `${name} at ${viewport.width}`,
      );
      for (const href of await page
        .locator("a[href]")
        .evaluateAll((anchors) => anchors.map((anchor) => anchor.href))) {
        const url = new URL(href);
        if (url.origin === base) links.add(url.href);
      }
      for (const src of await page
        .locator("script[src],link[href]")
        .evaluateAll((nodes) => nodes.map((node) => node.src ?? node.href))) {
        if (new URL(src).origin === base)
          assert.equal((await context.request.get(src)).status(), 200, src);
      }
      if (name === "index.html") {
        await page.screenshot({
          path: join(root, `work/home-${viewport.width}.png`),
          fullPage: true,
        });
        if (viewport.width < 760)
          await page.screenshot({
            path: join(root, `work/home-${viewport.width}-viewport.png`),
          });
        await page
          .getByRole("button", { name: "Copy provider environment variables" })
          .click();
        await page.waitForFunction(
          () =>
            globalThis.document.querySelector(".copy-status").textContent ===
            "Code copied to clipboard.",
        );
        assert.match(
          await page.evaluate(() => globalThis.navigator.clipboard.readText()),
          /YADA_LLM_PROVIDER=anthropic/,
        );
        assert.equal(
          await page.locator("[role=status]").textContent(),
          "Code copied to clipboard.",
        );
        await page.keyboard.press("Control+Home");
        await page.reload();
        await page.keyboard.press("Tab");
        assert.equal(
          await page.locator(":focus").textContent(),
          "Skip to content",
        );
        await page.keyboard.press("Enter");
        assert.equal(await page.locator(":focus").getAttribute("id"), "main");
      } else {
        const current = page.locator(`a[aria-current=page][href="/${name}"]`);
        assert.equal(
          await current.count(),
          2,
          `${name}: active desktop and mobile docs links`,
        );
        if (viewport.width < 760) {
          await page.getByText("Documentation menu", { exact: true }).click();
          assert.equal(
            await page.locator(".mobile-docs-nav").getAttribute("open"),
            "",
          );
          await page.getByText("Documentation menu", { exact: true }).click();
        }
        if (name === "configuration.html")
          await page.screenshot({
            path: join(root, `work/docs-${viewport.width}.png`),
            fullPage: true,
          });
      }
    }
    for (const href of links) {
      const url = new URL(href);
      assert.equal((await context.request.get(url.href)).status(), 200, href);
      await page.goto(url.href);
      if (url.hash)
        assert.equal(
          await page.evaluate(
            (id) =>
              globalThis.document.getElementById(decodeURIComponent(id)) !==
              null,
            url.hash.slice(1),
          ),
          true,
          href,
        );
    }
    await context.close();
  }
  assert.deepEqual(failures, []);
  console.log(
    `Verified ${files.length} rendered Pages on desktop/mobile, ${links.size} internal links, assets, copy, keyboard navigation and WCAG 2.1 AA checks`,
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
