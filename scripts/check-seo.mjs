import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

export function createSeoCheck({ siteUrl, mount, output, files }) {
  assert.match(siteUrl, /^https:\/\//);
  const home = `${siteUrl}${mount}/`;
  const titles = new Set();
  const descriptions = new Set();
  return async (page, name) => {
    const canonical = `${home}${name === "index.html" ? "" : name}`;
    assert.equal(await page.locator("head title").count(), 1);
    const title = (await page.title()).trim();
    assert(title.includes("Yada"));
    assert(!titles.has(title), `${name}: duplicate title`);
    titles.add(title);
    const meta = async (selector) => {
      const node = page.locator(`head meta[${selector}]`);
      assert.equal(await node.count(), 1, `${name}: ${selector}`);
      const value = await node.getAttribute("content");
      assert(value?.trim(), `${name}: empty ${selector}`);
      return value;
    };
    const description = await meta('name="description"');
    assert(!descriptions.has(description), `${name}: duplicate description`);
    descriptions.add(description);
    assert.equal(await page.locator('head link[rel="canonical"]').count(), 1);
    assert.equal(
      await page.locator('head link[rel="canonical"]').getAttribute("href"),
      canonical,
    );
    assert.equal(await meta('property="og:url"'), canonical);
    assert.equal(await meta('property="og:type"'), "website");
    assert.equal(await meta('property="og:site_name"'), "Yada");
    for (const selector of ['property="og:title"', 'name="twitter:title"'])
      assert.equal(await meta(selector), title);
    for (const selector of [
      'property="og:description"',
      'name="twitter:description"',
    ])
      assert.equal(await meta(selector), description);
    assert.equal(await meta('name="twitter:card"'), "summary_large_image");
    const image = `${home}assets/brand/yada-social.png`;
    assert.equal(await meta('property="og:image"'), image);
    assert.equal(await meta('name="twitter:image"'), image);
    assert.equal(await meta('property="og:image:type"'), "image/png");
    assert.equal(await meta('property="og:image:width"'), "1200");
    assert.equal(await meta('property="og:image:height"'), "630");
    assert.equal(
      await meta('property="og:image:alt"'),
      await meta('name="twitter:image:alt"'),
    );
    const scripts = page.locator('head script[type="application/ld+json"]');
    assert.equal(await scripts.count(), 1);
    const data = JSON.parse(await scripts.textContent());
    assert.equal(data["@context"], "https://schema.org");
    assert.equal(data["@graph"].length, 3);
    const website = data["@graph"].find(
      (entry) => entry["@type"] === "WebSite",
    );
    const source = data["@graph"].find(
      (entry) => entry["@type"] === "SoftwareSourceCode",
    );
    const webPage = data["@graph"].find(
      (entry) => entry["@type"] === "WebPage",
    );
    assert.equal(website["@id"], `${home}#website`);
    assert.equal(website.url, home);
    assert.equal(website.name, "Yada");
    assert.equal(source["@id"], `${home}#source`);
    assert.equal(source.url, home);
    assert.equal(source.codeRepository, "https://github.com/edgar4/yada");
    assert.equal(source.programmingLanguage, "TypeScript");
    assert.equal(source.runtimePlatform, "Node.js 24");
    assert.equal(webPage.url, canonical);
    assert.equal(webPage["@id"], canonical);
    assert.equal(webPage.name, title);
    assert.equal(webPage.description, description);
    assert.equal(webPage.isPartOf["@id"], website["@id"]);
    assert.equal(webPage.about["@id"], source["@id"]);
    if (name !== "index.html") return;
    const png = await readFile(join(output, "assets/brand/yada-social.png"));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    const imageResponse = await page
      .context()
      .request.get(
        new URL(`${mount}/assets/brand/yada-social.png`, page.url()).href,
      );
    assert.equal(imageResponse.status(), 200);
    assert.equal(imageResponse.headers()["content-type"], "image/png");
    const xml = await readFile(join(output, "sitemap.xml"), "utf8");
    const locations = await page.evaluate((source) => {
      const doc = new globalThis.DOMParser().parseFromString(
        source,
        "application/xml",
      );
      if (doc.querySelector("parsererror"))
        throw new Error("Invalid sitemap XML");
      return [...doc.getElementsByTagName("loc")].map(
        (node) => node.textContent,
      );
    }, xml);
    assert.deepEqual(
      locations.sort(),
      files.map((file) => `${home}${file === "index.html" ? "" : file}`).sort(),
    );
    const robots = await readFile(join(output, "robots.txt"), "utf8");
    assert.match(robots, /^User-agent: \*\s+Allow: \/\s+Sitemap: https:\/\//);
    assert.equal(
      robots.trim().split("\n").at(-1),
      `Sitemap: ${home}sitemap.xml`,
    );
    assert(!robots.includes("Disallow:"));
    for (const file of ["sitemap.xml", "robots.txt"])
      assert.equal(
        (
          await page
            .context()
            .request.get(new URL(`${mount}/${file}`, page.url()).href)
        ).status(),
        200,
      );
  };
}
