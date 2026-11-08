import {
  BrowserClient,
  ClientError,
  type Job,
  type JobInput,
  type RunEvent,
} from "../client/index.js";
import { contentText } from "../client/validate.js";
import { markdown } from "./markdown.js";
import { safeUrl, sanitize } from "./sanitize.js";
import { baseStyles, defaultStyles } from "./styles.js";
import type { Approval } from "../client/index.js";

export { ClientError } from "../client/index.js";
export { widgetExportParts, widgetParts, type WidgetPart } from "./parts.js";
export { cssVariables } from "./styles.js";

const defaultLabels = {
  title: "{name}",
  empty: "Send a message to start the conversation.",
  conversation: "Conversation",
  message: "Message",
  placeholder: "Message {name}",
  send: "Send",
  cancel: "Cancel run",
  reconnect: "Reconnect",
  you: "You: ",
  ready: "Ready",
  loading: "Loading conversation",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  toolRunning: "Running {tool}",
  toolFinished: "Finished {tool}",
  tool: "tool",
  queued: "queued",
  running: "running",
  awaitingApproval: "awaiting approval",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  cancelRequested: "Cancellation requested",
  approved: "Action approved",
  declined: "Action declined",
  approvalGroup: "Action approval",
  approvalTitle: "Review action before approving",
  approve: "Approve action",
  decline: "Decline action",
  remember: "Remember this approval for this run",
  loadFailed: "Could not load the saved run.",
  connectionFailed: "Connection failed. Reconnect to resume this run.",
  cancelFailed: "Cancellation failed. Try again.",
  decisionFailed:
    "Approval decision failed. Reconnect to review its current status.",
  steerFailed: "Could not send your message. Try again.",
  errorFailed: "The run failed.",
  errorCancelled: "The run was cancelled.",
  errorLimit: "The run stopped after reaching its usage limit.",
  errorDependencyFailed: "A service the assistant depends on failed.",
  errorRefused: "The assistant declined to answer this request.",
  errorTimeout: "The run took too long and was stopped.",
  errorRetryExhausted: "The run failed after several attempts.",
  errorCorruptRecord:
    "This run's saved data was damaged, so it was stopped. Send a new message to continue.",
};
const namedLabels: Partial<typeof defaultLabels> = {
  title: "{name}",
  empty: "Send {name} a message to start the conversation.",
  conversation: "Conversation with {name}",
  message: "Message {name}",
  placeholder: "Message {name}",
  errorDependencyFailed: "A service {name} depends on failed.",
  errorRefused: "{name} declined to answer this request.",
};
export type WidgetLabels = Readonly<Record<keyof typeof defaultLabels, string>>;
const errorLabels: Record<string, keyof WidgetLabels> = {
  limit: "errorLimit",
  dependency_failed: "errorDependencyFailed",
  refused: "errorRefused",
  timeout: "errorTimeout",
  retry_exhausted: "errorRetryExhausted",
  corrupt_record: "errorCorruptRecord",
  cancelled: "errorCancelled",
};
const statusLabels: Record<string, keyof WidgetLabels> = {
  queued: "queued",
  running: "running",
  awaiting_approval: "awaitingApproval",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};
export type WidgetMessage = Readonly<{
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
}>;
export type WidgetRenderHelpers = Readonly<{
  markdown: (text: string) => DocumentFragment;
  text: (text: string) => Text;
}>;
export type WidgetApprovalActions = Readonly<{
  approve: (options?: Readonly<{ remember?: boolean }>) => void;
  decline: () => void;
  disabled: boolean;
  canRemember: boolean;
}>;
export type WidgetActivity = Readonly<{
  tool: string;
  phase: "started" | "finished";
  failed: boolean;
}>;
export type WidgetRendered = Node | string | null | undefined;
export type WidgetSuggestion =
  string | Readonly<{ label: string; text: string }>;
export type WidgetAvatar =
  Readonly<{ image: string }> | Readonly<{ text: string }> | false;
export type WidgetComposerOptions = Readonly<{
  autoGrow?: boolean;
  send?: "text" | "icon";
  enter?: "send" | "newline";
}>;
export type WidgetOptions = Readonly<{
  client: BrowserClient;
  conversationId: string;
  profileId: string;
  labels?: Partial<WidgetLabels>;
  name?: string;
  subtitle?: string;
  avatar?: WidgetAvatar;
  header?: boolean;
  fill?: boolean;
  colorScheme?: "light" | "dark" | "auto";
  styles?: string | CSSStyleSheet;
  unstyled?: boolean;
  composer?: WidgetComposerOptions;
  suggestions?: readonly WidgetSuggestion[];
  renderMessage?: (
    message: WidgetMessage,
    helpers: WidgetRenderHelpers,
  ) => WidgetRendered;
  renderApproval?: (
    approval: Approval,
    actions: WidgetApprovalActions,
    helpers: WidgetRenderHelpers,
  ) => WidgetRendered;
  renderActivity?: (
    activity: WidgetActivity,
    helpers: WidgetRenderHelpers,
  ) => WidgetRendered;
  formatApprovalPreview?: (
    preview: string,
    approval: Approval,
    helpers: WidgetRenderHelpers,
  ) => WidgetRendered;
}>;
export type WidgetState = "idle" | "running" | "awaiting-approval" | "error";
type RunPhase = "idle" | "running" | "awaiting-approval" | "settling";
export type WidgetRunDetail = Readonly<{
  conversationId: string;
  runId: string;
}>;
export type WidgetRunEndDetail = WidgetRunDetail &
  Readonly<{ status: "completed" | "failed" | "cancelled" }>;
export type WidgetReadyDetail = Readonly<{ conversationId: string }>;
export type WidgetMessageDetail = WidgetRunDetail &
  Readonly<{ text: string; steering: boolean }>;
export type WidgetApprovalDetail = WidgetRunDetail &
  Readonly<{ approvalId: string; preview: string }>;
export type WidgetApprovalDecidedDetail = WidgetRunDetail &
  Readonly<{ approvalId: string; approved: boolean; remember: boolean }>;
export type WidgetErrorDetail = Readonly<{
  conversationId: string;
  runId?: string;
  kind:
    "run" | "connection" | "load" | "cancel" | "decision" | "steer" | "render";
  code?: string;
  message: string;
}>;
export type WidgetEventMap = {
  "yada-ready": WidgetReadyDetail;
  "yada-run": WidgetRunDetail;
  "yada-run-end": WidgetRunEndDetail;
  "yada-message": WidgetMessageDetail;
  "yada-approval": WidgetApprovalDetail;
  "yada-approval-decided": WidgetApprovalDecidedDetail;
  "yada-error": WidgetErrorDetail;
};
export interface YadaWidget extends HTMLElement {
  configure(options: WidgetOptions): void;
  resume(runId: string): Promise<void>;
}
const part = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  name: string,
  className?: string,
) => {
  const element = document.createElement(tag);
  element.setAttribute("part", name);
  if (className) element.className = className;
  return element;
};
const slot = (name: string) => {
  const element = document.createElement("slot");
  element.name = name;
  return element;
};
const faceMarkup = `<svg class="face" viewBox="0 0 120 120" aria-hidden="true"><circle class="face-background" cx="60" cy="60" r="60"/><g class="face-features" data-mood="neutral"><path d="M30 32Q45 46 60 60M90 32Q75 46 60 60M60 60V90"/><circle class="face-dot" cx="60" cy="60" r="9"/></g><g class="face-features" data-mood="thinking"><path d="M50 40V42M74 40V42M52 80Q64 76 76 80"/></g><g class="face-features" data-mood="smile"><path d="M44 42V54M76 42V54M40 72Q60 92 80 72"/></g><g class="face-features" data-mood="wink"><path d="M44 42V54M67 52Q76 38 85 52M42 74Q62 90 80 70"/></g></svg>`;
function createFace() {
  const template = document.createElement("template");
  template.innerHTML = faceMarkup;
  return template.content;
}
function sendIconSlot(): HTMLSlotElement {
  const element = slot("send-icon");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", "M3 20.5 21 12 3 3.5V10l12 2-12 2z");
  svg.append(path);
  element.append(svg);
  return element;
}
const sheets = new Map<string, CSSStyleSheet>();
function sheetFor(css: string): CSSStyleSheet {
  let sheet = sheets.get(css);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    sheets.set(css, sheet);
  }
  return sheet;
}

const isFinished = (status: string) =>
  ["completed", "failed", "cancelled"].includes(status);

export function defineYadaWidget(name = "yada-chat"): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(name)) return;
  class ChatWidget extends HTMLElement implements YadaWidget {
    private options: WidgetOptions | undefined;
    private controller: AbortController | undefined;
    private input: JobInput | undefined;
    private cursor = 0;
    private phase: RunPhase = "idle";
    private readonly root = this.attachShadow({ mode: "open" });
    private readonly section = part("section", "root");
    private readonly header = part("header", "header");
    private readonly avatar = part("span", "avatar", "avatar");
    private readonly avatarFallback = document.createElement("span");
    private readonly avatarSlot = slot("avatar");
    private readonly titleEl = part("h2", "title");
    private readonly subtitle = part("p", "subtitle", "subtitle");
    private readonly log = part("div", "log", "log");
    private readonly empty = part("div", "empty", "empty");
    private readonly emptyAvatar = part("span", "empty-avatar", "empty-avatar");
    private readonly emptyText = part("p", "empty-text", "empty-text");
    private readonly suggestions = part("div", "suggestions", "suggestions");
    private readonly activity = part("div", "activity", "activity");
    private readonly typing = part("div", "typing", "typing");
    private readonly typingAvatar = part(
      "span",
      "typing-avatar",
      "typing-avatar",
    );
    private readonly status = part("p", "status", "visually-hidden");
    private readonly error = part("p", "error", "error");
    private readonly promptLabel = document.createElement("label");
    private readonly prompt = part("textarea", "input");
    private readonly send = part("button", "send");
    private readonly cancel = part("button", "stop");
    private readonly retry = part("button", "retry");
    private readonly approval = part("div", "approval");
    private readonly preview = part("pre", "approval-preview");
    private readonly approvalTitle = part("h3", "approval-title");
    private readonly remember = part("input", "remember-input");
    private readonly rememberLabel = part("label", "remember", "remember");
    private readonly approve = part("button", "approve", "approve");
    private readonly decline = part("button", "decline", "decline");
    private readonly aboveComposer = part("div", "above-composer");
    private readonly footer = part("div", "footer");
    private readonly sendIcon = sendIconSlot();
    private readonly styleElements: HTMLStyleElement[] = [];
    private approvalId: string | undefined;
    private readonly steered = new Map<string, string>();
    private unconfirmedSteer: { id: string; text: string } | undefined;
    private live: HTMLElement | undefined;
    private liveText = "";
    private labels: WidgetLabels = defaultLabels;
    private disconnected = false;
    private readyFor: WidgetOptions | undefined;
    static readonly observedAttributes = ["name"];

    constructor() {
      super();
      const form = part("form", "composer");
      const heading = document.createElement("div");
      heading.className = "heading";
      const emptySlot = slot("empty");
      const headerSlot = slot("header");
      const aboveSlot = slot("above-composer");
      const footerSlot = slot("footer");
      this.avatarSlot.append(this.avatarFallback);
      this.avatar.setAttribute("aria-hidden", "true");
      this.avatar.append(this.avatarSlot);
      this.subtitle.hidden = true;
      heading.append(this.titleEl, this.subtitle);
      headerSlot.append(this.avatar, heading);
      this.header.append(headerSlot);
      this.log.setAttribute("role", "log");
      this.log.setAttribute("aria-live", "polite");
      this.log.setAttribute("aria-relevant", "additions");
      this.emptyAvatar.setAttribute("aria-hidden", "true");
      emptySlot.append(this.emptyAvatar, this.emptyText);
      this.empty.append(emptySlot, this.suggestions);
      this.log.append(this.empty);
      this.activity.hidden = true;
      this.typing.setAttribute("aria-hidden", "true");
      this.typing.append(
        this.typingAvatar,
        part("span", "typing-dot"),
        part("span", "typing-dot"),
        part("span", "typing-dot"),
      );
      this.status.setAttribute("role", "status");
      this.error.setAttribute("role", "alert");
      this.prompt.id = "message";
      this.prompt.name = "message";
      this.prompt.required = true;
      this.prompt.maxLength = 32_000;
      this.promptLabel.htmlFor = this.prompt.id;
      this.promptLabel.className = "visually-hidden";
      this.send.type = "submit";
      this.cancel.type = "button";
      this.cancel.hidden = true;
      this.retry.type = "button";
      this.retry.hidden = true;
      this.approval.setAttribute("role", "group");
      this.remember.type = "checkbox";
      this.rememberLabel.append(this.remember, document.createTextNode(""));
      this.approve.type = this.decline.type = "button";
      this.restoreApprovalCard();
      form.append(
        this.promptLabel,
        this.prompt,
        this.send,
        this.cancel,
        this.retry,
      );
      this.aboveComposer.append(aboveSlot);
      this.footer.append(footerSlot);
      this.section.append(
        this.header,
        this.log,
        this.activity,
        this.typing,
        this.status,
        this.error,
        this.approval,
        this.aboveComposer,
        form,
        this.footer,
      );
      this.root.append(this.section);
      this.applyStyles();
      this.refreshLabels();
      this.status.textContent = this.labels.ready;
      this.revealSlots();
      for (const name of [this.avatarSlot, aboveSlot, footerSlot])
        name.addEventListener("slotchange", () => {
          this.revealSlots();
        });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.sendText(this.prompt.value);
      });
      this.prompt.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) return;
        const sends =
          this.options?.composer?.enter === "newline"
            ? event.metaKey || event.ctrlKey
            : !event.shiftKey;
        if (sends) {
          event.preventDefault();
          form.requestSubmit();
        }
      });
      this.prompt.addEventListener("input", () => {
        this.grow();
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

    attributeChangedCallback(): void {
      this.refreshLabels();
    }

    private emit<K extends keyof WidgetEventMap>(
      type: K,
      detail: WidgetEventMap[K],
    ): void {
      this.dispatchEvent(
        new CustomEvent(type, { detail, bubbles: true, composed: true }),
      );
    }

    private setError(
      message: string,
      kind?: WidgetErrorDetail["kind"],
      code?: string,
    ): void {
      this.error.textContent = message;
      this.update();
      if (!kind || !message || !this.options) return;
      this.emit("yada-error", {
        conversationId: this.options.conversationId,
        ...(this.input ? { runId: this.input.id } : {}),
        kind,
        ...(code ? { code } : {}),
        message,
      });
    }

    private setPrompt(value: string): void {
      this.prompt.value = value;
      this.grow();
    }

    private grow(): void {
      const { prompt } = this;
      const autoGrow = this.options?.composer?.autoGrow ?? true;
      prompt.rows = autoGrow ? 1 : 2;
      prompt.toggleAttribute("data-auto-grow", autoGrow);
      if (!autoGrow || CSS.supports("field-sizing", "content")) {
        prompt.style.removeProperty("height");
        return;
      }
      prompt.style.height = "auto";
      prompt.style.height = `${String(
        prompt.scrollHeight + prompt.offsetHeight - prompt.clientHeight,
      )}px`;
    }

    private applyStyles(): void {
      const { unstyled, styles: custom } = this.options ?? {};
      const css = unstyled ? baseStyles : baseStyles + defaultStyles;
      for (const element of this.styleElements.splice(0)) element.remove();
      try {
        const extra = typeof custom === "string" ? sheetFor(custom) : custom;
        this.root.adoptedStyleSheets = [
          sheetFor(css),
          ...(extra ? [extra] : []),
        ];
      } catch {
        for (const text of [
          css,
          ...(typeof custom === "string" ? [custom] : []),
        ]) {
          const style = document.createElement("style");
          style.textContent = text;
          this.styleElements.push(style);
          this.root.append(style);
        }
      }
    }

    private helpers: WidgetRenderHelpers = {
      markdown,
      text: (text) => document.createTextNode(text),
    };

    private rendered(build: () => WidgetRendered): Node | undefined {
      try {
        const output = build();
        if (output === null || output === undefined) return undefined;
        return typeof output === "string"
          ? document.createTextNode(output)
          : sanitize(output);
      } catch (error) {
        if (this.options)
          this.emit("yada-error", {
            conversationId: this.options.conversationId,
            kind: "render",
            message: error instanceof Error ? error.message : String(error),
          });
        return undefined;
      }
    }

    private messageContent(
      text: string,
      role: "user" | "assistant",
      streaming: boolean,
    ): Node | undefined {
      const render = this.options?.renderMessage;
      return (
        render &&
        this.rendered(() => render({ role, text, streaming }, this.helpers))
      );
    }

    private revealSlots(): void {
      this.avatar.hidden =
        !this.avatarFallback.childNodes.length &&
        !this.avatarSlot.assignedNodes().length;
      this.emptyAvatar.hidden = this.typingAvatar.hidden =
        !this.avatarFallback.childNodes.length;
      for (const wrapper of [this.aboveComposer, this.footer])
        wrapper.hidden = !wrapper.querySelector("slot")?.assignedNodes().length;
    }

    private restoreApprovalCard(): void {
      this.approval.replaceChildren(
        this.approvalTitle,
        this.preview,
        this.rememberLabel,
        this.approve,
        this.decline,
      );
    }

    private sendText(text: string): void {
      if (!this.options || this.phase === "settling" || !text.trim()) return;
      if (this.active) {
        this.setPrompt(text);
        void this.steerRun();
        return;
      }
      this.appendMessage(text, "user");
      this.submit(text);
      this.setPrompt("");
    }

    private submit(text: string): void {
      if (!this.options) return;
      this.input = this.options.client.createInput(
        this.options.profileId,
        text,
      );
      this.cursor = 0;
      this.steered.clear();
      this.unconfirmedSteer = undefined;
      const detail = {
        conversationId: this.options.conversationId,
        runId: this.input.id,
      };
      this.emit("yada-run", detail);
      this.emit("yada-message", {
        ...detail,
        text,
        steering: false,
      });
      void this.start(true);
    }

    private refreshLabels(): void {
      const named = this.options?.name ?? this.getAttribute("name");
      const shown = named || "Yada";
      this.labels = Object.fromEntries(
        Object.entries({
          ...defaultLabels,
          ...(named ? namedLabels : {}),
          ...this.options?.labels,
        }).map(([key, value]) => [
          key,
          value.replaceAll("{name}", () => shown),
        ]),
      ) as WidgetLabels;
      this.applyLabels();
    }

    private applyLabels(): void {
      const text = this.labels;
      this.titleEl.textContent = text.title;
      this.promptLabel.textContent = text.message;
      this.log.setAttribute("aria-label", text.conversation);
      this.emptyText.textContent = text.empty;
      this.prompt.placeholder = text.placeholder;
      if (this.options?.composer?.send !== "text") {
        this.send.replaceChildren(this.sendIcon);
        this.send.setAttribute("aria-label", text.send);
      } else {
        this.send.textContent = text.send;
        this.send.removeAttribute("aria-label");
      }
      this.cancel.textContent = text.cancel;
      this.retry.textContent = text.reconnect;
      this.approval.setAttribute("aria-label", text.approvalGroup);
      this.approvalTitle.textContent = text.approvalTitle;
      this.approve.textContent = text.approve;
      this.decline.textContent = text.decline;
      this.rememberLabel.lastChild?.replaceWith(
        document.createTextNode(text.remember),
      );
      if (this.options?.header === false)
        this.section.setAttribute("aria-label", text.title);
      else this.section.removeAttribute("aria-label");
    }

    private applyIdentity(): void {
      const { avatar, subtitle, header, fill, colorScheme, unstyled } =
        this.options ?? {};
      this.header.hidden = header === false;
      this.subtitle.textContent = subtitle ?? "";
      this.subtitle.hidden = !subtitle;
      this.avatarFallback.replaceChildren();
      if (avatar && "text" in avatar) this.avatarFallback.append(avatar.text);
      else if (avatar && safeUrl(avatar.image)) {
        const image = document.createElement("img");
        image.alt = "";
        image.src = avatar.image;
        this.avatarFallback.append(image);
      } else if (avatar === undefined && !unstyled)
        this.avatarFallback.append(createFace());
      for (const copy of [this.emptyAvatar, this.typingAvatar])
        copy.replaceChildren(
          ...[...this.avatarFallback.childNodes].map((node) =>
            node.cloneNode(true),
          ),
        );
      this.revealSlots();
      if (fill !== undefined) this.toggleAttribute("fill", fill);
      if (colorScheme) this.setAttribute("color-scheme", colorScheme);
    }

    private applySuggestions(): void {
      const items = this.options?.suggestions ?? [];
      this.suggestions.hidden = !items.length;
      this.suggestions.replaceChildren(
        ...items.map((item) => {
          const button = part("button", "suggestion", "suggestion");
          const { label, text } =
            typeof item === "string" ? { label: item, text: item } : item;
          button.type = "button";
          button.textContent = label;
          button.addEventListener("click", () => {
            this.prompt.focus();
            this.sendText(text);
          });
          return button;
        }),
      );
    }

    private announceReady(): void {
      const { options } = this;
      if (!options || this.readyFor === options) return;
      this.readyFor = options;
      queueMicrotask(() => {
        if (this.options === options && this.isConnected)
          this.emit("yada-ready", {
            conversationId: options.conversationId,
          });
      });
    }

    private reset(): void {
      this.controller?.abort();
      this.input = undefined;
      this.cursor = 0;
      this.steered.clear();
      this.unconfirmedSteer = undefined;
      this.phase = "idle";
      this.disconnected = false;
      this.cancel.disabled = false;
      this.log.replaceChildren(this.empty);
      this.live = undefined;
      this.liveText = "";
      this.clearActivity();
      this.error.textContent = "";
      this.status.textContent = this.labels.ready;
      this.cancel.hidden = this.retry.hidden = true;
      this.update();
    }

    configure(options: WidgetOptions): void {
      this.options = options;
      this.applyStyles();
      this.refreshLabels();
      this.applyIdentity();
      this.applySuggestions();
      this.reset();
      this.grow();
      if (this.isConnected) this.announceReady();
    }

    async resume(runId: string): Promise<void> {
      if (!this.options)
        throw new Error("Configure the widget before resuming a run");
      const options = this.options;
      this.reset();
      const controller = new AbortController();
      this.controller = controller;
      this.status.textContent = this.labels.loading;
      this.phase = "running";
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
          if (turn.role === "user" || turn.role === "assistant")
            this.appendMessage(contentText(turn.content), turn.role);
        this.appendMessage(contentText(job.input), "user");
        for (const message of job.steering)
          this.appendMessage(contentText(message.input), "user");
        this.phase = "running";
        this.update();
        void this.start(false, job);
      } catch (error) {
        if (this.isCurrent(controller)) {
          if (error instanceof ClientError && error.status === 404)
            this.reset();
          else {
            this.phase = "idle";
            this.status.textContent = this.labels.ready;
            this.setError(this.labels.loadFailed, "load");
          }
        }
        throw error;
      }
    }

    connectedCallback(): void {
      this.update();
      this.revealSlots();
      this.grow();
      this.announceReady();
      if (!this.input) return;
      if (this.active) void this.start(false);
      else if (this.steered.size) {
        const controller = new AbortController();
        this.controller = controller;
        void this.resendUnconsumed(controller);
      }
    }

    disconnectedCallback(): void {
      this.controller?.abort();
    }

    private get active(): boolean {
      return this.phase === "running" || this.phase === "awaiting-approval";
    }

    private update(): void {
      this.send.disabled = this.prompt.disabled =
        !this.options ||
        this.phase === "settling" ||
        (this.active && !this.input);
      this.cancel.hidden = !this.active || !this.input;
      this.approval.hidden = this.phase !== "awaiting-approval";
      this.typing.hidden =
        this.phase !== "running" || this.disconnected || !!this.live;
      const state: WidgetState = this.disconnected
        ? "error"
        : this.phase === "awaiting-approval"
          ? "awaiting-approval"
          : this.active
            ? "running"
            : this.error.textContent
              ? "error"
              : "idle";
      this.dataset["state"] = state;
      this.dataset["mood"] =
        state === "running"
          ? "thinking"
          : state === "awaiting-approval"
            ? "wink"
            : state === "idle" && !this.empty.isConnected
              ? "smile"
              : "neutral";
      this.dataset["connection"] = this.disconnected
        ? "disconnected"
        : "connected";
    }

    private markConnected(): void {
      if (!this.disconnected) return;
      this.disconnected = false;
      this.update();
    }

    private clearActivity(): void {
      this.activity.replaceChildren();
      this.activity.hidden = true;
    }

    private clearLive(): void {
      this.live?.remove();
      this.live = undefined;
      this.liveText = "";
      if (!this.log.children.length) this.log.append(this.empty);
    }

    private isCurrent(controller: AbortController): boolean {
      return this.controller === controller && !controller.signal.aborted;
    }

    private appendMessage(text: string, role: "user" | "assistant"): void {
      this.empty.remove();
      const custom = this.messageContent(text, role, false);
      const bubble = part(
        role === "user" && !custom ? "p" : "div",
        `message ${role}`,
        role,
      );
      if (role === "user") {
        const speaker = document.createElement("span");
        speaker.className = "speaker visually-hidden";
        speaker.textContent = this.labels.you;
        bubble.append(speaker, custom ?? text);
      } else bubble.append(custom ?? markdown(text));
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
      this.phase = "running";
      this.disconnected = false;
      this.cancel.disabled = false;
      this.error.textContent = "";
      this.retry.hidden = true;
      this.clearLive();
      this.status.textContent = this.labels.connecting;
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
            if (this.isCurrent(controller)) {
              this.status.textContent = this.labels.reconnecting;
              this.disconnected = true;
              this.update();
            }
          },
        })) {
          if (!this.isCurrent(controller)) return;
          this.cursor = event.sequence;
          this.markConnected();
          await this.showEvent(event, controller.signal);
        }
        if (this.isCurrent(controller)) await this.resendUnconsumed(controller);
      } catch (error) {
        if (!this.isCurrent(controller)) return;
        if (!create && error instanceof ClientError && error.status === 404) {
          this.reset();
          return;
        }
        this.disconnected = true;
        this.status.textContent = this.labels.disconnected;
        this.retry.hidden = false;
        this.setError(this.labels.connectionFailed, "connection");
      }
    }

    private async showEvent(
      event: RunEvent,
      signal: AbortSignal,
      restore = false,
    ): Promise<void> {
      signal.throwIfAborted();
      if (event.type === "text_delta") {
        this.liveText += event.text ?? "";
        this.clearActivity();
        if (!this.live) {
          this.empty.remove();
          this.live = part("div", "message assistant", "assistant");
          this.log.append(this.live);
          this.update();
        }
        this.live.replaceChildren(
          this.messageContent(this.liveText, "assistant", true) ??
            markdown(this.liveText),
        );
        this.log.scrollTop = this.log.scrollHeight;
        return;
      }
      if (event.type === "usage") return;
      if (event.type === "tool_started" || event.type === "tool_finished") {
        this.clearLive();
        this.status.textContent = this.labels[
          event.type === "tool_started" ? "toolRunning" : "toolFinished"
        ].replace("{tool}", () => event.tool ?? this.labels.tool);
        const render = this.options?.renderActivity;
        const activity =
          render &&
          this.rendered(() =>
            render(
              {
                tool: event.tool ?? this.labels.tool,
                phase: event.type === "tool_started" ? "started" : "finished",
                failed: event.failed ?? false,
              },
              this.helpers,
            ),
          );
        this.activity.replaceChildren(...(activity ? [activity] : []));
        this.activity.hidden = !activity;
        this.update();
        return;
      }
      this.clearActivity();
      const statusLabel = statusLabels[event.type];
      this.status.textContent = statusLabel
        ? this.labels[statusLabel]
        : event.type.replaceAll("_", " ");
      if (event.text || ["failed", "cancelled"].includes(event.type))
        this.clearLive();
      if (event.type === "failed" || event.type === "cancelled")
        this.setError(
          this.labels[
            (event.code && errorLabels[event.code]) ||
              (event.type === "failed" ? "errorFailed" : "errorCancelled")
          ],
          event.type === "failed" ? "run" : undefined,
          event.code,
        );
      if (event.text && !restore) this.appendMessage(event.text, "assistant");
      if (this.phase === "awaiting-approval") this.phase = "running";
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
        this.showApproval(approval);
      }
      if (isFinished(event.type)) {
        this.phase = this.steered.size > 0 ? "settling" : "idle";
        this.update();
        this.prompt.focus();
        if (this.options && this.input)
          this.emit("yada-run-end", {
            conversationId: this.options.conversationId,
            runId: this.input.id,
            status: event.type as WidgetRunEndDetail["status"],
          });
      }
    }

    private showApproval(approval: Approval): void {
      this.approvalId = approval.id;
      this.remember.checked = false;
      const canRemember = (approval.remember ?? ["run"]).includes("run");
      this.rememberLabel.hidden = !canRemember;
      const disabled =
        approval.status !== "pending" || approval.expiresAt <= Date.now();
      this.approve.disabled = this.decline.disabled = disabled;
      const { renderApproval, formatApprovalPreview } = this.options ?? {};
      const card =
        renderApproval &&
        this.rendered(() =>
          renderApproval(
            approval,
            {
              disabled,
              canRemember,
              approve: (options) => {
                if (this.approve.disabled) return;
                this.remember.checked = options?.remember ?? false;
                void this.decide(true);
              },
              decline: () => {
                if (!this.decline.disabled) void this.decide(false);
              },
            },
            this.helpers,
          ),
        );
      if (card) this.approval.replaceChildren(card);
      else {
        this.restoreApprovalCard();
        this.preview.replaceChildren(
          (formatApprovalPreview &&
            this.rendered(() =>
              formatApprovalPreview(approval.preview, approval, this.helpers),
            )) ??
            approval.preview,
        );
      }
      this.phase = "awaiting-approval";
      this.update();
      if (card) {
        const focusable = this.approval.querySelector<HTMLElement>(
          "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]",
        );
        if (focusable) focusable.focus();
        else {
          this.approval.tabIndex = -1;
          this.approval.focus();
        }
      } else this.approve.focus();
      if (this.options && this.input)
        this.emit("yada-approval", {
          conversationId: this.options.conversationId,
          runId: this.input.id,
          approvalId: approval.id,
          preview: approval.preview,
        });
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
          this.status.textContent = this.labels.cancelRequested;
      } catch {
        if (this.isCurrent(controller) && this.active)
          this.setError(this.labels.cancelFailed, "cancel");
      } finally {
        if (this.isCurrent(controller)) this.cancel.disabled = false;
      }
    }

    private async steerRun(): Promise<void> {
      const { options, input, controller } = this;
      const text = this.prompt.value;
      if (!options || !input || !controller || !this.isCurrent(controller))
        return;
      this.send.disabled = true;
      const id =
        this.unconfirmedSteer?.text === text
          ? this.unconfirmedSteer.id
          : crypto.randomUUID();
      this.unconfirmedSteer = { id, text };
      try {
        await options.client.steer(
          options.conversationId,
          input.id,
          text,
          id,
          controller.signal,
        );
        if (!this.isCurrent(controller)) return;
        this.unconfirmedSteer = undefined;
        this.steered.set(id, text);
        this.appendMessage(text, "user");
        this.setPrompt("");
        this.setError("");
        this.emit("yada-message", {
          conversationId: options.conversationId,
          runId: input.id,
          text,
          steering: true,
        });
        if (!this.active) await this.resendUnconsumed(controller);
      } catch (error) {
        if (!this.isCurrent(controller)) return;
        if (
          !(error instanceof ClientError && error.status === 409) ||
          !(await this.startFollowUp(text, controller))
        )
          this.setError(this.labels.steerFailed, "steer");
      } finally {
        this.update();
      }
    }

    private async startFollowUp(
      text: string,
      stale: AbortController,
    ): Promise<boolean> {
      const { options, input } = this;
      if (!options || !input) return false;
      const job = await options.client
        .getRun(options.conversationId, input.id, stale.signal)
        .catch(() => undefined);
      if (!job || !this.isCurrent(stale) || !isFinished(job.status))
        return false;
      stale.abort();
      const controller = new AbortController();
      this.controller = controller;
      for (const event of job.events)
        if (event.sequence > this.cursor) {
          this.cursor = event.sequence;
          await this.showEvent(event, controller.signal);
        }
      if (this.phase === "settling") this.phase = "idle";
      this.restoreUnconsumed(job, text);
      this.update();
      return true;
    }

    private async resendUnconsumed(controller: AbortController): Promise<void> {
      const { options, input } = this;
      if (!options || !input || !this.steered.size) return;
      if (!this.active) this.phase = "settling";
      this.update();
      const job = await options.client
        .getRun(options.conversationId, input.id, controller.signal)
        .catch(() => undefined);
      if (this.phase === "settling") this.phase = "idle";
      this.update();
      if (!this.isCurrent(controller)) return;
      if (!job) this.setError(this.labels.steerFailed, "steer");
      this.restoreUnconsumed(job);
    }

    private restoreUnconsumed(job: Job | undefined, followUp = ""): void {
      const unread = job
        ? job.steering
            .filter((item) => !item.consumed && this.steered.has(item.id))
            .map((item) => contentText(item.input))
        : [...this.steered.values()];
      if (job) for (const { id } of job.steering) this.steered.delete(id);
      else this.steered.clear();
      if (job?.status === "completed") {
        if (followUp) {
          this.appendMessage(followUp, "user");
          this.setPrompt("");
        }
        const text = [...unread, ...(followUp ? [followUp] : [])].join("\n\n");
        if (text) this.submit(text);
      } else if (unread.length)
        this.setPrompt(
          [...unread, this.prompt.value].filter(Boolean).join("\n\n"),
        );
      this.prompt.focus();
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
      const remember = approved && this.remember.checked;
      try {
        await options.client.decide(
          options.conversationId,
          input.id,
          approvalId,
          approved,
          controller.signal,
          remember ? "run" : undefined,
        );
        this.emit("yada-approval-decided", {
          conversationId: options.conversationId,
          runId: input.id,
          approvalId,
          approved,
          remember,
        });
        if (
          !this.isCurrent(controller) ||
          !this.active ||
          this.cursor !== cursor ||
          this.approvalId !== approvalId
        )
          return;
        this.phase = "running";
        this.update();
        this.status.textContent = approved
          ? this.labels.approved
          : this.labels.declined;
        this.cancel.focus();
      } catch {
        if (
          this.isCurrent(controller) &&
          this.active &&
          this.cursor === cursor &&
          this.approvalId === approvalId
        ) {
          this.retry.hidden = false;
          this.setError(this.labels.decisionFailed, "decision");
        }
      }
    }
  }
  customElements.define(name, ChatWidget);
}
