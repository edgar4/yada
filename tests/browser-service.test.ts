import { expect, it, vi } from "vitest";
import { chromium } from "@playwright/test";
import { once } from "node:events";
import { z } from "zod";
import { BrowserClient, type RunEvent } from "../src/client/index.js";
import { readTool } from "../src/core/tool.js";
import { writeTool, type ActionContext } from "../src/core/action.js";
import { createFakeProvider } from "../src/providers/fake.js";
import { createHandler } from "../src/service/http.js";
import { createNodeServer } from "../src/service/node.js";
import { createWorker } from "../src/service/worker.js";
import { storageFixture } from "./helpers/storage.js";
import { browserModules } from "./helpers/browser-modules.js";

const input = "Look up order 42 and rename it to Ada";
const output = "Order 42 renamed to Ada.";
const preview = "Rename order 42 from Original to Ada";
const html = `<!doctype html><html lang="en"><head><title>Real service rehearsal</title>
<script type="importmap">{"imports":{"zod":"/node_modules/zod/index.js"}}</script></head><body>
<main><h1>Order support</h1><yada-chat></yada-chat></main>
<script type="module">
import { BrowserClient } from '/src/client/index.js';
import { defineYadaWidget } from '/src/widget/index.js';
defineYadaWidget();
const widget = document.querySelector('yada-chat');
widget.addEventListener('yada-run', event => sessionStorage.setItem('runId', event.detail.runId));
widget.configure({client:new BrowserClient({baseUrl:location.origin,headers:()=>({authorization:'Bearer local-test'}),reconnectDelayMs:10}),conversationId:'orders',profileId:'support'});
const saved = sessionStorage.getItem('runId');
if(saved) await widget.resume(saved);
</script></body></html>`;

it(
  "preserves browser approval, replay and idempotency through the real service and SQLite",
  { timeout: 30_000 },
  async () => {
    const fixture = await storageFixture("sqlite");
    let orderName = "Original";
    let revision = 1;
    const read = vi.fn(() =>
      Promise.resolve(`Order 42: ${orderName}, revision ${String(revision)}`),
    );
    const write = vi.fn(
      (args: { id: 42; name: "Ada" }, context: ActionContext) => {
        orderName = args.name;
        revision++;
        return Promise.resolve(
          `Receipt: ${context.operationId}: order 42 renamed to ${args.name}`,
        );
      },
    );
    const readOrder = readTool({
      name: "lookup_order",
      description: "Look up an order",
      input: z.strictObject({ id: z.literal(42) }),
      authorize: (identity) =>
        Promise.resolve(identity.actorId === fixture.identity.actorId),
      execute: read,
    });
    const renameOrder = writeTool({
      name: "rename_order",
      description: "Rename an order",
      version: "1",
      input: z.strictObject({ id: z.literal(42), name: z.literal("Ada") }),
      authorize: (identity) =>
        Promise.resolve(identity.actorId === fixture.identity.actorId),
      prepare: () =>
        Promise.resolve({
          preview: `Rename order 42 from ${orderName} to Ada`,
          version: `revision-${String(revision)}`,
        }),
      execute: write,
      reconcile: () => Promise.resolve(undefined),
    });
    const provider = createFakeProvider((request) => {
      const toolNames = request.messages
        .filter((turn) => turn.role === "tool")
        .map((turn) => turn.name);
      if (!toolNames.includes("lookup_order"))
        return {
          content: "",
          toolCalls: [{ id: "lookup", name: "lookup_order", args: { id: 42 } }],
          finishReason: "tool_calls",
        };
      if (!toolNames.includes("rename_order"))
        return {
          content: "",
          toolCalls: [
            {
              id: "rename",
              name: "rename_order",
              args: { id: 42, name: "Ada" },
            },
          ],
          finishReason: "tool_calls",
        };
      return { content: output, toolCalls: [], finishReason: "stop" };
    });
    const makeWorker = () =>
      createWorker({
        storage: fixture.storage,
        profiles: {
          support: {
            provider,
            tools: [readOrder, renameOrder],
            system: "Help with order changes",
            timeoutMs: 5000,
          },
        },
      });
    let worker = makeWorker();
    const origins: string[] = [];
    const makeHandler = () =>
      createHandler({
        storage: fixture.storage,
        origins,
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("authorization") === "Bearer local-test"
              ? fixture.identity
              : undefined,
          ),
        authorizeProfile: (_identity, profile) =>
          Promise.resolve(profile === "support"),
      });
    let handler = makeHandler();
    const cursors: number[] = [];
    let disconnects = 0;
    const server = createNodeServer((request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/")) {
        if (url.pathname.endsWith("/events")) {
          cursors.push(Number(url.searchParams.get("after") ?? 0));
          request.signal.addEventListener(
            "abort",
            () => {
              disconnects++;
            },
            { once: true },
          );
        }
        return handler(request);
      }
      return browserModules(request, html);
    });
    const browser = await chromium.launch({ headless: true });
    const monitor = new AbortController();
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server address");
      const origin = `http://127.0.0.1:${String(address.port)}`;
      origins.push(origin);
      const client = new BrowserClient({
        baseUrl: origin,
        headers: () => ({ authorization: "Bearer local-test" }),
        reconnectDelayMs: 10,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
      });
      await page.goto(origin);
      let widget = page.locator("yada-chat");
      await widget.getByRole("textbox", { name: "Message" }).fill(input);
      await widget.getByRole("button", { name: "Send", exact: true }).click();
      const runId = await page.evaluate(() => sessionStorage.getItem("runId"));
      if (!runId) throw new Error("Widget did not expose its run ID");
      await expect
        .poll(async () => (await client.getRun("orders", runId)).status)
        .toBe("queued");
      const request = client.createInput("support", input, runId);
      expect(await client.createRun("orders", request)).toMatchObject({
        id: runId,
        status: "queued",
      });
      const subscription = client.events("orders", runId, {
        signal: monitor.signal,
      });
      const first = await subscription.next();
      expect(first.value).toMatchObject({ sequence: 1, type: "queued" });
      await subscription.return(undefined);
      expect((await client.getRun("orders", runId)).cancelRequested).toBe(
        false,
      );
      await worker.tick();
      await worker.tick();
      await widget.getByRole("button", { name: "Approve action" }).waitFor();
      expect(await widget.locator("pre").textContent()).toBe(preview);
      expect(read).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect(orderName).toBe("Original");
      const awaiting = await client.getRun("orders", runId);
      expect(awaiting.status).toBe("awaiting_approval");
      const approvalId = awaiting.events.at(-1)?.approvalId;
      if (!approvalId) throw new Error("Missing approval event");
      expect(
        await client.getApproval("orders", runId, approvalId),
      ).toMatchObject({ preview, status: "pending" });
      const beforeReload = disconnects;
      await page.reload();
      widget = page.locator("yada-chat");
      await widget.getByRole("button", { name: "Approve action" }).waitFor();
      await expect.poll(() => disconnects).toBeGreaterThan(beforeReload);
      expect(await page.evaluate(() => sessionStorage.getItem("runId"))).toBe(
        runId,
      );
      expect(
        await widget
          .getByRole("log")
          .getByText(`You: ${input}`, { exact: true })
          .count(),
      ).toBe(1);
      expect(write).not.toHaveBeenCalled();
      const beforeRestart = disconnects;
      await page.goto("about:blank");
      await expect.poll(() => disconnects).toBeGreaterThan(beforeRestart);
      await worker.stop();
      await fixture.reopen();
      handler = makeHandler();
      worker = makeWorker();
      await page.goto(origin);
      widget = page.locator("yada-chat");
      await widget.getByRole("button", { name: "Approve action" }).waitFor();
      expect((await client.getRun("orders", runId)).status).toBe(
        "awaiting_approval",
      );
      expect(orderName).toBe("Original");
      const replay: RunEvent[] = [];
      const observed = (async () => {
        for await (const event of client.events("orders", runId, {
          after: 1,
          signal: AbortSignal.any([
            monitor.signal,
            AbortSignal.timeout(10_000),
          ]),
        }))
          replay.push(event);
      })();
      void observed.catch(() => undefined);
      await widget.getByRole("button", { name: "Approve action" }).click();
      await expect
        .poll(
          async () =>
            (await fixture.storage.actions.load(fixture.identity, approvalId))
              ?.status,
        )
        .toBe("approved");
      await worker.tick();
      await worker.tick();
      await observed;
      await expect
        .poll(async () => widget.getByRole("status").textContent())
        .toBe("completed");
      expect(
        await widget
          .getByRole("log")
          .getByText(output, { exact: true })
          .count(),
      ).toBe(1);
      expect(await widget.getByRole("textbox").isDisabled()).toBe(false);
      const complete = await client.getRun("orders", runId);
      expect(complete.outcome).toEqual({ status: "completed", text: output });
      expect(replay).toEqual(complete.events.slice(1));
      expect(replay.map((event) => event.sequence)).toEqual(
        complete.events.slice(1).map((_, index) => index + 2),
      );
      expect(replay.filter((event) => event.type === "completed")).toHaveLength(
        1,
      );
      expect(cursors).toContain(1);
      expect(await client.createRun("orders", request)).toEqual(complete);
      await worker.tick();
      await worker.tick();
      expect(read).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(orderName).toBe("Ada");
      expect(revision).toBe(2);
      expect(write.mock.calls[0]?.[1]).toMatchObject({
        identity: fixture.identity,
        operationId: approvalId,
        version: "revision-1",
      });
      expect(provider.requests).toHaveLength(3);
      expect(
        (await fixture.storage.actions.load(fixture.identity, approvalId))
          ?.status,
      ).toBe("completed");
      expect(
        (await fixture.storage.conversations.load(fixture.identity, "orders"))
          ?.messages,
      ).toEqual([
        { role: "user", content: input },
        { role: "assistant", content: output },
      ]);
      expect(errors).toEqual([]);
      await page.reload();
      await expect
        .poll(async () =>
          page.locator("yada-chat").getByRole("status").textContent(),
        )
        .toBe("completed");
      expect(
        await page
          .locator("yada-chat")
          .getByRole("log")
          .getByText(output, { exact: true })
          .count(),
      ).toBe(1);
    } finally {
      monitor.abort();
      await browser.close();
      await worker.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  },
);
