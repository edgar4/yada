# Browser client and widget

Import the browser entrypoints through your application's module bundler. They do not import provider adapters, storage, Node APIs, or secrets. Serve the API over HTTPS and provide host authentication through cookies or a header callback. Keep provider keys on the server.

```ts
import { BrowserClient } from "yada/client";
import { defineYadaWidget, type YadaWidget } from "yada/widget";

const client = new BrowserClient({
  baseUrl: location.origin,
  credentials: "same-origin",
  headers: async () => ({ authorization: `Bearer ${await getSessionToken()}` }),
});
defineYadaWidget();
const widget = document.querySelector<YadaWidget>("yada-chat");
widget?.configure({
  client,
  conversationId: "support-chat",
  profileId: "support",
});
```

Place `<yada-chat></yada-chat>` in the host markup. `defineYadaWidget()` explicitly registers the component, accepts an optional custom element name, and does nothing during server rendering. Configure the element after registration. Registration is idempotent. Rendering creates no global styles or UI outside the element's Shadow DOM.

The host owns authentication, conversation identity, profile selection, and API deployment. `baseUrl` is an absolute HTTP(S) URL prefix; the client appends `/v1/conversations/...`. `credentials` defaults to `same-origin`. The optional `headers` callback runs for every request and retry so refreshed authentication can be used. Cross-origin deployments require the server to allow the host origin and relevant credentials/headers. The client does not persist credentials.

## Framework-independent runs

```ts
const input = client.createInput("support", "Check order 42");
const job = await client.createRun("support-chat", input);
const controller = new AbortController();
let cursor = 0;
for await (const event of client.events("support-chat", job.id, {
  after: cursor,
  signal: controller.signal,
  onReconnect: () => showConnectionStatus("Reconnecting"),
})) {
  cursor = event.sequence;
  renderText(event.text ?? event.type);
}
```

Persist the input ID before submission if the host must recover across page reloads. Retrying `createRun` with the same `JobInput` preserves the server's idempotency boundary. `createInput` accepts an explicit third-argument ID for host persistence. `getRun` retrieves the durable snapshot. For a widget, call `await widget.resume(savedRunId)` after configuration to load its saved history and replay the run without submitting new input. The host owns persistence of that run ID. Before submission, the widget emits a bubbling, composed `yada-run` CustomEvent with `{ conversationId, runId }` (`WidgetRunDetail`); persist that detail to reconnect after reload. Creation retries keep the same ID. Persist the last processed event sequence and pass it as `after` to resume. Events are version-validated, contiguous and deduplicated; terminal events close iteration. Persist application effects together with the cursor if exactly-once display or downstream processing is required.

Network failures and HTTP 5xx responses retry up to `maxRetries` (default 3, maximum 10), with exponential backoff starting at `reconnectDelayMs` (default 500, maximum 30000) and capped at 30 seconds. Authentication failures, invalid event payloads and sequence gaps fail immediately. Each subscription has a bounded reconnect budget. When exhausted, explicitly subscribe again with the last cursor. Event lines are limited to 64 KiB and JSON response bodies to 2 MiB. Abort signals stop fetches, readers and retry waits; disconnecting does not cancel the server run.

Call `cancel(conversationId, runId)` to request server cancellation. Cancellation is asynchronous; consume the terminal event to learn the final result. For `awaiting_approval`, fetch `getApproval(conversationId, runId, approvalId)`, show its preview as text, and submit an explicit `decide(..., approved)` choice. The server enforces ownership, expiry and decision validity. A decision request can fail if the action expires or its state changes; fetch the current approval before offering another decision.

## Widget behavior and themes

The widget includes a labeled message field, keyboard-operable controls, a polite conversation log, status announcements, alerts and visible focus indicators. While a run is active, message submission is disabled. Approval controls show the server preview as text and require an explicit approve or decline. Expired or nonpending approval snapshots disable decision buttons. Server events and previews use text nodes, never HTML.

Reconnect preserves the submitted input ID and event cursor. Removing an element aborts its browser requests; reattaching the same element resumes its active run. `configure` aborts the prior subscription and resets local display state. Explicit **Cancel run** requests server cancellation. Approval and cancellation failures appear in the alert region. Hosts should call `configure` when account or conversation identity changes.

Set CSS custom properties on the host element:

```css
yada-chat {
  --yada-background: #fffdf8;
  --yada-color: #244534;
  --yada-accent: #286345;
  --yada-button-color: #ffffff;
  --yada-border: #b2c3af;
  --yada-input-background: #ffffff;
  --yada-focus: #286345;
  --yada-error: #b91c1c;
  --yada-radius: 20px;
  --yada-font: 17px/1.6 Georgia, serif;
  --yada-spacing: 24px;
  --yada-log-height: 320px;
}
```

Choose colors with sufficient contrast. Host selectors cannot reach internal controls; theme variables inherit through Shadow DOM. The source examples in `examples/browser/retail.html` and `examples/browser/operations.html` show unrelated host styles with the same component and shared setup. Serve them through a TypeScript-aware host bundler, proxy `/v1` to the service on the same origin, and provision the named conversation/profile IDs for the authenticated host identity.

## Verification

`tests/client.test.ts` covers authenticated retries, stable IDs, replay, malformed and oversized responses, terminal closure and aborts. `tests/widget.browser.test.ts` starts a local HTTP fixture and runs real Chromium with axe accessibility audits, keyboard interaction, malicious content, independent themes, approvals, transport interruptions, cancellation and element lifecycle checks. Install Chromium using `npx playwright install chromium` before running the tests. Widget execution occurs in Chromium and is checked by this mandatory browser suite; Vitest's Node V8 coverage applies separately to the SDK and other server modules.
