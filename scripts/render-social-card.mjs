import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "@playwright/test";

const mark = await readFile(
  new URL("../docs/assets/brand/yada-mark-light.svg", import.meta.url),
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Yada social preview</title><style>
  * { box-sizing:border-box; } body { margin:0; width:1200px; height:630px; background:#FFF6E5; color:#1F1A3D; font-family:Arial,sans-serif; padding:56px 76px; border-bottom:12px solid #FFB547; }
  header { display:flex; align-items:center; gap:20px; } img { width:88px; height:88px; } .name { font-size:46px; font-weight:700; letter-spacing:-2px; } .name span { color:#E07A00; }
  .label { margin-left:auto; font-size:18px; font-weight:700; letter-spacing:2px; }
  h1 { font-size:76px; line-height:1.06; letter-spacing:-3px; margin:38px 0 26px; font-weight:700; }
  p { margin:0; font-size:26px; line-height:1.5; } footer { margin-top:33px; font-size:21px; font-weight:700; letter-spacing:.2px; }
  </style></head><body><header><img src="data:image/svg+xml;base64,${mark.toString("base64")}" alt="Yada knowing Y"><div class="name">yada<span>.</span></div><div class="label">TYPESCRIPT AGENT RUNTIME</div></header><h1>An assistant inside<br>your application.</h1><p>Typed tools · Approved actions · Durable runs</p><footer>yada.edgar.co.ke</footer></body></html>`);
  await page.evaluate(() => globalThis.document.fonts.ready);
  await page.screenshot({
    path: fileURLToPath(
      new URL("../docs/assets/brand/yada-social.png", import.meta.url),
    ),
  });
} finally {
  await browser.close();
}
