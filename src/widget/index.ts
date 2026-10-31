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
export type WidgetRunDetail = Readonly<{
  conversationId: string;
  runId: string;
}>;
export interface YadaWidget extends HTMLElement {
  configure(options: WidgetOptions): void;
  resume(runId: string): Promise<void>;
}
const styles = `
:host { display:block; color:var(--yada-color,#172033); font:var(--yada-font,16px/1.5 system-ui,sans-serif); }
* { box-sizing:border-box; }
section { display:flex; flex-direction:column; background:var(--yada-background,#fff); border:1px solid var(--yada-border,#cbd5e1); border-radius:var(--yada-radius,12px); overflow:hidden; }
h2 { font-size:1em; margin:0; padding:12px var(--yada-spacing,16px); border-bottom:1px solid var(--yada-border,#cbd5e1); }
.log { display:flex; flex-direction:column; gap:8px; height:var(--yada-log-height,320px); overflow:auto; overflow-wrap:anywhere; padding:var(--yada-spacing,16px); }
.log:empty::before { content:"Send a message to start the conversation."; margin:auto; opacity:.65; }
.log > * { margin:0; max-width:80%; padding:10px 14px; border-radius:18px; line-height:1.55; }
.log > p { white-space:pre-wrap; }
.assistant > * { margin:0 0 .6em; }
.assistant > :last-child { margin-bottom:0; }
.assistant p { white-space:pre-wrap; }
.assistant ul, .assistant ol { padding-left:1.25em; }
.assistant li + li { margin-top:.25em; }
.assistant code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; padding:1px 5px; border-radius:5px; background:rgb(0 0 0 / .06); }
.assistant pre.code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.875em; padding:10px 12px; border-radius:10px; background:rgb(0 0 0 / .06); overflow:auto; white-space:pre; }
.log .user { align-self:flex-end; color:var(--yada-button-color,#fff); background:var(--yada-accent,#1d4ed8); border-bottom-right-radius:4px; }
.log .assistant { align-self:flex-start; background:var(--yada-bubble-background,#f1f5f9); border-bottom-left-radius:4px; }
.speaker, label, [role="status"] { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.error { margin:0; padding:0 var(--yada-spacing,16px) 8px; font-size:.875em; }
.error:empty { padding:0; }
.typing { display:flex; gap:4px; align-self:flex-start; margin:0 var(--yada-spacing,16px) 10px; padding:12px 14px; width:max-content; border-radius:18px; border-bottom-left-radius:4px; background:var(--yada-bubble-background,#f1f5f9); }
.typing span { width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.35; animation:yada-typing 1.2s infinite ease-in-out; }
.typing span:nth-child(2) { animation-delay:.15s; }
.typing span:nth-child(3) { animation-delay:.3s; }
@keyframes yada-typing { 0%, 60%, 100% { opacity:.35; transform:none; } 30% { opacity:.9; transform:translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .typing span { animation:none; } }
[role="group"] { margin:0 var(--yada-spacing,16px) 12px; padding:12px 16px; border:1px solid var(--yada-border,#cbd5e1); border-radius:var(--yada-radius,12px); }
h3 { font-size:1em; margin:0 0 8px; }
form { display:grid; grid-template-columns:1fr auto; gap:8px; align-items:end; padding:12px var(--yada-spacing,16px); border-top:1px solid var(--yada-border,#cbd5e1); }
textarea { display:block; width:100%; min-height:48px; max-height:160px; resize:vertical; font:inherit; color:inherit; background:var(--yada-input-background,#fff); border:1px solid var(--yada-border,#64748b); border-radius:var(--yada-radius,8px); padding:12px 14px; }
button { font:inherit; cursor:pointer; padding:10px 18px; border:1px solid var(--yada-border,#64748b); border-radius:var(--yada-radius,8px); color:var(--yada-button-color,#fff); background:var(--yada-accent,#1d4ed8); }
[role="group"] button { margin:8px 8px 0 0; }
form button:not([type="submit"]) { grid-column:1 / -1; justify-self:start; }
button:disabled { opacity:.6; cursor:default; }
:focus-visible { outline:3px solid var(--yada-focus,#2563eb); outline-offset:3px; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; margin:0; }
[hidden] { display:none !important; }
.error { color:var(--yada-error,#b91c1c); }
`;

function inline(text: string): Node[] {
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/;
  return text.split(pattern).map((part, index) => {
    if (index % 2 === 0) return document.createTextNode(part);
    if (part.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      return code;
    }
    const strong = part.startsWith("**") || part.startsWith("__");
    const node = document.createElement(strong ? "strong" : "em");
    node.append(...inline(part.slice(strong ? 2 : 1, strong ? -2 : -1)));
    return node;
  });
}

function markdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = text.split("\n");
  let paragraph: string[] = [];
  let list: HTMLElement | undefined;
  const flush = () => {
    if (paragraph.length) {
      const p = document.createElement("p");
      p.append(...inline(paragraph.join("\n")));
      fragment.append(p);
    }
    paragraph = [];
    list = undefined;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      while (
        ++index < lines.length &&
        !lines[index]?.trimStart().startsWith("```")
      )
        code.push(lines[index] ?? "");
      const pre = document.createElement("pre");
      pre.className = "code";
      pre.textContent = code.join("\n");
      fragment.append(pre);
    } else if (heading) {
      flush();
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      strong.append(...inline(heading[1] ?? ""));
      p.append(strong);
      fragment.append(p);
    } else if (item) {
      const tag = item[1] ? "ul" : "ol";
      if (list?.tagName.toLowerCase() !== tag) {
        flush();
        list = document.createElement(tag);
        fragment.append(list);
      }
      const li = document.createElement("li");
      li.append(...inline(item[2] ?? ""));
      list.append(li);
    } else if (!line.trim()) flush();
    else {
      list = undefined;
      paragraph.push(line);
    }
  }
  flush();
  return fragment;
}

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
    private readonly typing = document.createElement("div");
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
      this.typing.className = "typing";
      this.typing.setAttribute("aria-hidden", "true");
      this.typing.append(
        document.createElement("span"),
        document.createElement("span"),
        document.createElement("span"),
      );
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
        this.typing,
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
        this.appendMessage(this.prompt.value, "user");
        this.prompt.value = "";
        this.dispatchEvent(
          new CustomEvent<WidgetRunDetail>("yada-run", {
            detail: {
              conversationId: this.options.conversationId,
              runId: this.input.id,
            },
            bubbles: true,
            composed: true,
          }),
        );
        void this.start(true);
      });
      this.prompt.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          form.requestSubmit();
        }
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
      this.cancel.disabled = false;
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
      this.active = true;
      this.update();
      try {
        const job = await options.client.getRun(
          options.conversationId,
          runId,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        this.input = { id: job.id, profileId: job.profileId, input: job.input };
        for (const turn of job.history)
          this.appendMessage(turn.content, turn.role);
        this.appendMessage(job.input, "user");
        this.active = true;
        this.update();
        void this.start(false, job);
      } catch (error) {
        if (this.isCurrent(controller)) {
          this.active = false;
          this.error.textContent = "Could not load the saved run.";
          this.status.textContent = "Ready";
          this.update();
        }
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
      this.cancel.hidden = !this.active || !this.input;
      this.typing.hidden = !this.active || !this.approval.hidden;
    }

    private isCurrent(controller: AbortController): boolean {
      return this.controller === controller && !controller.signal.aborted;
    }

    private appendMessage(text: string, role: "user" | "assistant"): void {
      const bubble = document.createElement(role === "user" ? "p" : "div");
      bubble.className = role;
      if (role === "user") {
        const speaker = document.createElement("span");
        speaker.className = "speaker";
        speaker.textContent = "You: ";
        bubble.append(speaker, text);
      } else bubble.append(markdown(text));
      this.log.append(bubble);
      this.log.scrollTop = this.log.scrollHeight;
    }

    private async start(create: boolean, snapshot?: Job): Promise<void> {
      if (!this.options || !this.input || !this.isConnected) return;
      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;
      const { client, conversationId } = this.options;
      const input = this.input;
      this.active = true;
      this.cancel.disabled = false;
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
            if (this.isCurrent(controller))
              this.status.textContent = "Reconnecting";
          },
        })) {
          if (!this.isCurrent(controller)) return;
          this.cursor = event.sequence;
          await this.showEvent(event, controller.signal);
        }
      } catch {
        if (!this.isCurrent(controller)) return;
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
      signal.throwIfAborted();
      this.status.textContent = event.type.replaceAll("_", " ");
      if (event.text && !restore) this.appendMessage(event.text, "assistant");
      this.approval.hidden = true;
      this.update();
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
        this.update();
        this.approve.focus();
      }
      if (["completed", "failed", "cancelled"].includes(event.type)) {
        this.active = false;
        this.update();
        this.prompt.focus();
      }
    }

    private async cancelRun(): Promise<void> {
      const { options, input, controller } = this;
      if (!options || !input || !controller || !this.isCurrent(controller))
        return;
      this.cancel.disabled = true;
      try {
        await options.client.cancel(
          options.conversationId,
          input.id,
          controller.signal,
        );
        if (this.isCurrent(controller) && this.active)
          this.status.textContent = "Cancellation requested";
      } catch {
        if (this.isCurrent(controller) && this.active)
          this.error.textContent = "Cancellation failed. Try again.";
      } finally {
        if (this.isCurrent(controller)) this.cancel.disabled = false;
      }
    }

    private async decide(approved: boolean): Promise<void> {
      const { options, input, approvalId, controller, cursor } = this;
      if (
        !options ||
        !input ||
        !approvalId ||
        !controller ||
        !this.isCurrent(controller)
      )
        return;
      this.approve.disabled = this.decline.disabled = true;
      try {
        await options.client.decide(
          options.conversationId,
          input.id,
          approvalId,
          approved,
          controller.signal,
        );
        if (
          !this.isCurrent(controller) ||
          !this.active ||
          this.cursor !== cursor ||
          this.approvalId !== approvalId
        )
          return;
        this.approval.hidden = true;
        this.update();
        this.status.textContent = approved
          ? "Action approved"
          : "Action declined";
        this.cancel.focus();
      } catch {
        if (
          this.isCurrent(controller) &&
          this.active &&
          this.cursor === cursor &&
          this.approvalId === approvalId
        ) {
          this.error.textContent =
            "Approval decision failed. Reconnect to review its current status.";
          this.retry.hidden = false;
        }
      }
    }
  }
  customElements.define(name, ChatWidget);
}
