import {
  BrowserClient,
  type Job,
  type JobInput,
  type RunEvent,
} from "../client/index.js";

export type WidgetOptions = Readonly<{
  client: BrowserClient;
  conversationId: string;
  profileId: string;
}>;
export interface YadaWidget extends HTMLElement {
  configure(options: WidgetOptions): void;
  resume(runId: string): Promise<void>;
}
const styles = `
:host { display:block; color:var(--yada-color,#172033); font:var(--yada-font,16px/1.5 system-ui,sans-serif); }
* { box-sizing:border-box; }
section { background:var(--yada-background,#fff); border:1px solid var(--yada-border,#cbd5e1); border-radius:var(--yada-radius,12px); padding:var(--yada-spacing,16px); }
h2 { font-size:1.125em; margin:0 0 12px; }
.log { max-height:var(--yada-log-height,320px); overflow:auto; overflow-wrap:anywhere; }
.log p { white-space:pre-wrap; margin:8px 0; }
label { display:block; font-weight:600; }
textarea { display:block; width:100%; min-height:80px; resize:vertical; font:inherit; color:inherit; background:var(--yada-input-background,#fff); border:1px solid var(--yada-border,#64748b); border-radius:var(--yada-radius,8px); padding:8px; }
button { font:inherit; cursor:pointer; padding:8px 14px; margin:8px 8px 0 0; border:1px solid var(--yada-border,#64748b); border-radius:var(--yada-radius,8px); color:var(--yada-button-color,#fff); background:var(--yada-accent,#1d4ed8); }
button:disabled { opacity:.6; cursor:default; }
:focus-visible { outline:3px solid var(--yada-focus,#2563eb); outline-offset:3px; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; }
[hidden] { display:none !important; }
.error { color:var(--yada-error,#b91c1c); }
`;

export function defineYadaWidget(name = "yada-chat"): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(name)) return;
  class ChatWidget extends HTMLElement implements YadaWidget {
    private options: WidgetOptions | undefined;
    private controller: AbortController | undefined;
    private input: JobInput | undefined;
    private cursor = 0;
    private active = false;
    private readonly root = this.attachShadow({ mode: "open" });
    private readonly log = document.createElement("div");
    private readonly status = document.createElement("p");
    private readonly error = document.createElement("p");
    private readonly prompt = document.createElement("textarea");
    private readonly send = document.createElement("button");
    private readonly cancel = document.createElement("button");
    private readonly retry = document.createElement("button");
    private readonly approval = document.createElement("div");
    private readonly preview = document.createElement("pre");
    private readonly approve = document.createElement("button");
    private readonly decline = document.createElement("button");
    private approvalId: string | undefined;

    constructor() {
      super();
      const style = document.createElement("style");
      style.textContent = styles;
      const section = document.createElement("section");
      const title = document.createElement("h2");
      title.textContent = "Assistant";
      this.log.className = "log";
      this.log.setAttribute("role", "log");
      this.log.setAttribute("aria-label", "Conversation");
      this.log.setAttribute("aria-live", "polite");
      this.log.setAttribute("aria-relevant", "additions");
      this.status.setAttribute("role", "status");
      this.status.textContent = "Ready";
      this.error.setAttribute("role", "alert");
      this.error.className = "error";
      const form = document.createElement("form");
      const label = document.createElement("label");
      label.textContent = "Message";
      this.prompt.id = "message";
      this.prompt.name = "message";
      this.prompt.required = true;
      this.prompt.maxLength = 32_000;
      label.htmlFor = this.prompt.id;
      this.send.textContent = "Send";
      this.send.type = "submit";
      this.cancel.textContent = "Cancel run";
      this.cancel.type = "button";
      this.cancel.hidden = true;
      this.retry.textContent = "Reconnect";
      this.retry.type = "button";
      this.retry.hidden = true;
      this.approval.hidden = true;
      this.approval.setAttribute("role", "group");
      this.approval.setAttribute("aria-label", "Action approval");
      const approvalTitle = document.createElement("h3");
      approvalTitle.textContent = "Review action before approving";
      this.approve.textContent = "Approve action";
      this.decline.textContent = "Decline action";
      this.approve.type = this.decline.type = "button";
      this.approval.append(
        approvalTitle,
        this.preview,
        this.approve,
        this.decline,
      );
      form.append(label, this.prompt, this.send, this.cancel, this.retry);
      section.append(
        title,
        this.log,
        this.status,
        this.error,
        this.approval,
        form,
      );
      this.root.append(style, section);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!this.options || this.active || !this.prompt.value.trim()) return;
        this.input = this.options.client.createInput(
          this.options.profileId,
          this.prompt.value,
        );
        this.cursor = 0;
        this.appendMessage(`You: ${this.prompt.value}`);
        this.prompt.value = "";
        void this.start(true);
      });
      this.retry.addEventListener("click", () => {
        void this.start(true);
      });
      this.cancel.addEventListener("click", () => {
        void this.cancelRun();
      });
      this.approve.addEventListener("click", () => {
        void this.decide(true);
      });
      this.decline.addEventListener("click", () => {
        void this.decide(false);
      });
    }

    configure(options: WidgetOptions): void {
      this.controller?.abort();
      this.options = options;
      this.input = undefined;
      this.cursor = 0;
      this.active = false;
      this.log.replaceChildren();
      this.error.textContent = "";
      this.status.textContent = "Ready";
      this.approval.hidden = this.cancel.hidden = this.retry.hidden = true;
      this.update();
    }

    async resume(runId: string): Promise<void> {
      if (!this.options)
        throw new Error("Configure the widget before resuming a run");
      const options = this.options;
      this.configure(options);
      const controller = new AbortController();
      this.controller = controller;
      this.status.textContent = "Loading conversation";
      try {
        const job = await options.client.getRun(
          options.conversationId,
          runId,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        this.input = { id: job.id, profileId: job.profileId, input: job.input };
        for (const turn of job.history)
          this.appendMessage(
            `${turn.role === "user" ? "You" : "Assistant"}: ${turn.content}`,
          );
        this.appendMessage(`You: ${job.input}`);
        this.active = true;
        this.update();
        void this.start(false, job);
      } catch (error) {
        if (!controller.signal.aborted)
          this.error.textContent = "Could not load the saved run.";
        throw error;
      }
    }

    connectedCallback(): void {
      this.update();
      if (this.input && this.active) void this.start(false);
    }

    disconnectedCallback(): void {
      this.controller?.abort();
    }

    private update(): void {
      this.send.disabled = !this.options || this.active;
      this.prompt.disabled = !this.options || this.active;
      this.cancel.hidden = !this.active;
    }

    private appendMessage(text: string): void {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      this.log.append(paragraph);
      paragraph.scrollIntoView({ block: "nearest" });
    }

    private async start(create: boolean, snapshot?: Job): Promise<void> {
      if (!this.options || !this.input || !this.isConnected) return;
      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;
      const { client, conversationId } = this.options;
      const input = this.input;
      this.active = true;
      this.error.textContent = "";
      this.retry.hidden = true;
      this.status.textContent = "Connecting";
      this.update();
      try {
        const job =
          snapshot ??
          (create
            ? await client.createRun(conversationId, input, controller.signal)
            : await client.getRun(conversationId, input.id, controller.signal));
        controller.signal.throwIfAborted();
        const latest = job.events.at(-1);
        if (
          latest?.type === "awaiting_approval" &&
          latest.sequence <= this.cursor
        ) {
          await this.showEvent(latest, controller.signal, true);
        }
        for await (const event of client.events(conversationId, input.id, {
          after: this.cursor,
          signal: controller.signal,
          onReconnect: () => {
            this.status.textContent = "Reconnecting";
          },
        })) {
          this.cursor = event.sequence;
          await this.showEvent(event, controller.signal);
        }
      } catch {
        if (controller.signal.aborted) return;
        this.error.textContent =
          "Connection failed. Reconnect to resume this run.";
        this.status.textContent = "Disconnected";
        this.retry.hidden = false;
      }
    }

    private async showEvent(
      event: RunEvent,
      signal: AbortSignal,
      restore = false,
    ): Promise<void> {
      this.status.textContent = event.type.replaceAll("_", " ");
      if (event.text && !restore) this.appendMessage(event.text);
      this.approval.hidden = true;
      if (
        event.type === "awaiting_approval" &&
        event.approvalId &&
        this.options &&
        this.input
      ) {
        const approval = await this.options.client.getApproval(
          this.options.conversationId,
          this.input.id,
          event.approvalId,
          signal,
        );
        signal.throwIfAborted();
        this.approvalId = approval.id;
        this.preview.textContent = approval.preview;
        this.approve.disabled = this.decline.disabled =
          approval.status !== "pending" || approval.expiresAt <= Date.now();
        this.approval.hidden = false;
        this.approve.focus();
      }
      if (["completed", "failed", "cancelled"].includes(event.type)) {
        this.active = false;
        this.update();
        this.prompt.focus();
      }
    }

    private async cancelRun(): Promise<void> {
      if (!this.options || !this.input || !this.controller) return;
      this.cancel.disabled = true;
      try {
        await this.options.client.cancel(
          this.options.conversationId,
          this.input.id,
          this.controller.signal,
        );
        if (this.active) this.status.textContent = "Cancellation requested";
      } catch {
        if (!this.controller.signal.aborted)
          this.error.textContent = "Cancellation failed. Try again.";
      } finally {
        this.cancel.disabled = false;
      }
    }

    private async decide(approved: boolean): Promise<void> {
      if (!this.options || !this.input || !this.approvalId || !this.controller)
        return;
      this.approve.disabled = this.decline.disabled = true;
      try {
        await this.options.client.decide(
          this.options.conversationId,
          this.input.id,
          this.approvalId,
          approved,
          this.controller.signal,
        );
        this.approval.hidden = true;
        this.status.textContent = approved
          ? "Action approved"
          : "Action declined";
        this.cancel.focus();
      } catch {
        if (!this.controller.signal.aborted) {
          this.error.textContent =
            "Approval decision failed. Reconnect to review its current status.";
          this.retry.hidden = false;
        }
      }
    }
  }
  customElements.define(name, ChatWidget);
}
