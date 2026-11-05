(() => {
  const root = document.querySelector("[data-widget-demo]");
  const { Yada } = globalThis;
  if (!root || !Yada) return;
  const friendly = (field) =>
    field
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (letter) => letter.toUpperCase());
  const themes = {
    default: {},
    moss: {
      name: "Moss",
      subtitle: "Your garden helper",
      suggestions: ["What can I plant now?", "Book a soil test"],
      labels: {
        approve: "Yes, book it",
        decline: "Not now",
        approvalTitle: "Moss would like to do this",
      },
      formatApprovalPreview: (preview) =>
        preview.replace(/^(\w+):/gm, (_, field) => `${friendly(field)}:`),
      renderActivity: ({ tool, phase }) =>
        phase === "started" ? `Checking ${tool}…` : null,
      styles: `
        :host { --yada-accent:#3a5a1c; --yada-button-color:#fffdf5; --yada-background:#fffdf5; --yada-log-background:#f1efdf; --yada-bubble-background:#fffdf5; --yada-input-background:#fffdf5; --yada-border:#e3dfc9; --yada-control-border:#8a9470; --yada-focus:#4d7c0f; --yada-color:#27331a; --yada-title-font:600 19px/1.2 Georgia,serif; --yada-title-size:19px; --yada-empty-opacity:.85; --yada-face-background:#3a5a1c; --yada-face-color:#f5e9b8; --yada-face-dot:#f5e9b8; }
      `,
    },
    console: {
      name: "Console",
      colorScheme: "dark",
      header: false,
      avatar: false,
      composer: { enter: "newline", send: "text" },
      labels: {
        send: "Run",
        placeholder: "Ctrl+Enter to run",
        approve: "Confirm",
        decline: "Abort",
      },
      styles: `
        :host { --yada-background:#0b0f0c; --yada-log-background:#0b0f0c; --yada-button-color:#fff; --yada-color:#c8f7c5; --yada-accent:#166534; --yada-bubble-background:#111a13; --yada-input-background:#0b0f0c; --yada-border:#1f3b25; --yada-control-border:#4b7a55; --yada-radius:0; --yada-bubble-radius:0; --yada-bubble-tail-radius:0; --yada-font:14px/1.5 ui-monospace,Menlo,monospace; --yada-focus:#86efac; --yada-bubble-max-width:100%; }
        [part~="user"]::before { content:"$ "; }
      `,
    },
  };
  const scriptedClient = () => {
    let decision;
    let settle = () => undefined;
    let message = "";
    const decided = new Promise((resolve) => {
      settle = resolve;
    });
    const steps = async function* () {
      yield { type: "queued" };
      yield { type: "tool_started", tool: "calendar" };
      yield { type: "tool_finished", tool: "calendar" };
      yield { type: "awaiting_approval", approvalId: "demo" };
      await decided;
      yield decision === "cancel"
        ? { type: "cancelled" }
        : {
            type: "completed",
            text:
              decision === "approve"
                ? `You asked: ${message}\n\nApproved. This reply is **scripted**, so no model was involved.`
                : `You asked: ${message}\n\nDeclined, so nothing happened. This reply is **scripted**.`,
          };
    };
    return new Yada.BrowserClient({
      baseUrl: location.origin,
      fetch: async (url, init) => {
        const path = String(url);
        if (path.endsWith("/decision") || path.endsWith("/cancel")) {
          decision = path.endsWith("/cancel")
            ? "cancel"
            : JSON.parse(init.body).approved
              ? "approve"
              : "decline";
          settle();
          return Response.json({ accepted: true }, { status: 202 });
        }
        if (path.includes("/approvals/"))
          return Response.json({
            id: "demo",
            preview: "firstName: Testy\npreferredDay: Saturday",
            status: "pending",
            expiresAt: Date.now() + 600000,
          });
        if (path.includes("/events?")) {
          const after = Number(new URL(path).searchParams.get("after"));
          return new Response(
            new ReadableStream({
              async start(controller) {
                init.signal?.addEventListener("abort", () => {
                  controller.error(new Error("closed"));
                });
                let sequence = 0;
                for await (const step of steps()) {
                  sequence++;
                  if (sequence <= after) continue;
                  await new Promise((resolve) => setTimeout(resolve, 350));
                  if (init.signal?.aborted) return;
                  controller.enqueue(
                    new TextEncoder().encode(
                      `${JSON.stringify({ version: 1, at: Date.now(), sequence, ...step })}\n`,
                    ),
                  );
                }
                controller.close();
              },
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          );
        }
        const input = JSON.parse(init.body);
        message = typeof input.input === "string" ? input.input : "";
        return Response.json(
          {
            ...input,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: "queued",
            cancelRequested: false,
            history: [],
            steering: [],
            events: [],
          },
          { status: 202 },
        );
      },
    });
  };
  Yada.defineYadaWidget();
  const frame = root.querySelector(".widget-demo-frame");
  const buttons = [...root.querySelectorAll("[data-theme]")];
  const show = (theme) => {
    for (const button of buttons)
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.theme === theme),
      );
    const widget = document.createElement("yada-chat");
    frame.replaceChildren(widget);
    const configure = () => {
      widget.configure({
        client: scriptedClient(),
        conversationId: "demo",
        profileId: "demo",
        fill: true,
        ...themes[theme],
      });
    };
    configure();
  };
  for (const button of buttons)
    button.addEventListener("click", () => {
      show(button.dataset.theme);
    });
  show("default");
})();
