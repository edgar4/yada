import { BrowserClient, ClientError } from "@edgaralochi/yada/client";
import {
  defineYadaWidget,
  type YadaWidget,
  type WidgetRunDetail,
} from "@edgaralochi/yada/widget";

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node;
}
const login = element("login");
const chat = element("chat");
const form = element("login-form") as HTMLFormElement;
const password = element("password") as HTMLInputElement;
const loginButton = element("login-button") as HTMLButtonElement;
const logout = element("logout") as HTMLButtonElement;
const retry = element("retry") as HTMLButtonElement;
const status = element("status");
const error = element("error");
const container = element("widget");
const runKey = "yada-starter:run";
const conversationKey = "yada-starter:conversation";
const memory = new Map<string, string>();
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}
function remember(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    error.textContent =
      "Browser storage is unavailable. Your conversation cannot resume after a reload.";
  }
}
type Face = Record<"l" | "r" | "s" | "d", number[]>;
type Mood = "neutral" | "smile" | "wink" | "shock" | "anger" | "thinking";
const faces: Record<Mood, Face> = {
  neutral: {
    l: [30, 32, 45, 46, 60, 60],
    r: [90, 32, 75, 46, 60, 60],
    s: [60, 60, 60, 75, 60, 90],
    d: [60, 60, 9],
  },
  smile: {
    l: [44, 42, 44, 48, 44, 54],
    r: [76, 42, 76, 48, 76, 54],
    s: [40, 72, 60, 92, 80, 72],
    d: [60, 80, 0],
  },
  wink: {
    l: [44, 42, 44, 48, 44, 54],
    r: [67, 52, 76, 38, 85, 52],
    s: [42, 74, 62, 90, 80, 70],
    d: [60, 80, 0],
  },
  shock: {
    l: [44, 44, 44, 46, 44, 48],
    r: [76, 44, 76, 46, 76, 48],
    s: [60, 80, 60, 80, 60, 80.5],
    d: [60, 80, 11],
  },
  anger: {
    l: [32, 38, 41, 45, 50, 52],
    r: [88, 38, 79, 45, 70, 52],
    s: [44, 84, 60, 72, 76, 84],
    d: [60, 78, 0],
  },
  thinking: {
    l: [50, 40, 50, 41, 50, 42],
    r: [74, 40, 74, 41, 74, 42],
    s: [52, 80, 64, 76, 76, 80],
    d: [60, 78, 0],
  },
};
const moods: Partial<Record<string, Mood>> = {
  Connecting: "thinking",
  "Loading conversation": "thinking",
  Reconnecting: "thinking",
  queued: "thinking",
  running: "thinking",
  progress: "thinking",
  reconciling: "thinking",
  "Cancellation requested": "thinking",
  "awaiting approval": "shock",
  "Action approved": "smile",
  completed: "wink",
  failed: "anger",
  Disconnected: "anger",
  cancelled: "neutral",
};
const face = element("face");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
let shown: Face = structuredClone(faces.neutral);
let frame = 0;
function draw(f: Face): void {
  for (const key of ["l", "r", "s"] as const) {
    const p = f[key];
    face
      .querySelector(`[data-part="${key}"]`)
      ?.setAttribute(
        "d",
        `M${p.slice(0, 2).join(" ")} Q${p.slice(2, 4).join(" ")} ${p.slice(4).join(" ")}`,
      );
  }
  const dot = face.querySelector('[data-part="d"]');
  for (const [i, attr] of ["cx", "cy", "r"].entries())
    dot?.setAttribute(attr, String(f.d[i]));
}
function mood(name: Mood): void {
  const target = faces[name];
  cancelAnimationFrame(frame);
  if (still) {
    shown = structuredClone(target);
    draw(shown);
    return;
  }
  const from = structuredClone(shown);
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min((now - start) / 320, 1);
    const e = 1 - (1 - t) ** 3;
    for (const key of ["l", "r", "s", "d"] as const)
      shown[key] = from[key].map((v, i) => v + ((target[key][i] ?? v) - v) * e);
    draw(shown);
    if (t < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}
function follow(current: YadaWidget): void {
  const line = current.shadowRoot?.querySelector('[role="status"]');
  if (!line) return;
  new MutationObserver(() => {
    if (widget === current) mood(moods[line.textContent] ?? "smile");
  }).observe(line, { childList: true, characterData: true, subtree: true });
}
let widget: YadaWidget | undefined;
let authenticated = false;
let passwordRequired = true;
let generation = 0;
let pending = false;
let retryAction = () => {
  void checkSession();
};

function busy(value: boolean): void {
  pending = value;
  loginButton.disabled = logout.disabled = retry.disabled = value;
  form.setAttribute("aria-busy", String(value));
}
function detach(): void {
  widget?.remove();
  widget = undefined;
}
function signedOut(message = ""): void {
  generation++;
  authenticated = false;
  detach();
  password.value = "";
  login.hidden = false;
  chat.hidden = logout.hidden = retry.hidden = true;
  busy(false);
  status.textContent = "Sign in to continue.";
  error.textContent = message;
  mood(message ? "shock" : "neutral");
  password.focus();
}
const client = new BrowserClient({
  baseUrl: location.origin,
  credentials: "same-origin",
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401 && !init?.signal?.aborted)
      signedOut("Your session has expired. Sign in again.");
    return response;
  },
});
defineYadaWidget();

async function restore(): Promise<void> {
  if (!authenticated) return;
  detach();
  retry.hidden = true;
  const current = document.createElement("yada-chat") as YadaWidget;
  widget = current;
  let conversationId = stored(conversationKey);
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    remember(conversationKey, conversationId);
  }
  current.configure({ client, conversationId, profileId: "starter" });
  current.addEventListener("yada-run", (event) => {
    remember(runKey, (event as CustomEvent<WidgetRunDetail>).detail.runId);
  });
  container.append(current);
  follow(current);
  const runId = stored(runKey);
  if (!runId) return;
  status.textContent = "Restoring your conversation…";
  try {
    await current.resume(runId);
    if (widget === current)
      status.textContent = passwordRequired ? "Signed in." : "Ready.";
  } catch (failure) {
    if (widget !== current) return;
    if (failure instanceof ClientError && failure.status === 404) {
      remember(runKey, null);
      current.configure({ client, conversationId, profileId: "starter" });
      status.textContent =
        "Your previous run is no longer available. Start a new message.";
      return;
    }
    container.inert = true;
    mood("anger");
    error.textContent =
      "Could not restore your conversation. Try reconnecting.";
    retry.textContent = "Reconnect";
    retryAction = () => {
      container.inert = false;
      error.textContent = "";
      void restore();
    };
    retry.hidden = false;
  }
}
async function checkSession(): Promise<void> {
  const operation = ++generation;
  busy(true);
  status.textContent = "Checking your session…";
  error.textContent = "";
  try {
    const response = await fetch("/auth/session", {
      credentials: "same-origin",
      redirect: "error",
    });
    if (operation !== generation) return;
    if (response.status === 401) {
      signedOut();
      return;
    }
    if (!response.ok) throw new Error("Session unavailable");
    const session: unknown = await response.json();
    if (
      typeof session !== "object" ||
      session === null ||
      !("authenticated" in session) ||
      typeof session.authenticated !== "boolean"
    )
      throw new Error("Invalid session");
    if (operation !== generation) return;
    if (!session.authenticated) {
      signedOut();
      return;
    }
    const opening = !authenticated || !widget || container.inert;
    authenticated = true;
    passwordRequired =
      !("passwordRequired" in session) || session.passwordRequired !== false;
    login.hidden = retry.hidden = true;
    chat.hidden = false;
    logout.hidden = !passwordRequired;
    container.inert = false;
    status.textContent = passwordRequired ? "Signed in." : "Ready.";
    busy(false);
    if (opening) mood("smile");
    if (opening) await restore();
  } catch {
    if (operation !== generation) return;
    busy(false);
    container.inert = true;
    status.textContent = "Connection unavailable.";
    mood("anger");
    error.textContent = "Could not check your session. Try again.";
    retry.textContent = "Try again";
    retryAction = () => {
      void checkSession();
    };
    retry.hidden = false;
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pending || !password.value) return;
  const operation = ++generation;
  busy(true);
  error.textContent = "";
  status.textContent = "Signing in…";
  mood("thinking");
  const body = JSON.stringify({ password: password.value });
  password.value = "";
  void (async () => {
    try {
      const response = await fetch("/auth/login", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body,
      });
      if (operation !== generation) return;
      if (!response.ok) {
        busy(false);
        status.textContent = "Sign in to continue.";
        error.textContent =
          response.status === 401
            ? "That password was not accepted."
            : "Could not sign in. Try again.";
        mood("shock");
        password.focus();
        return;
      }
      await checkSession();
    } catch {
      if (operation !== generation) return;
      busy(false);
      status.textContent = "Sign in to continue.";
      error.textContent = "Could not sign in. Try again.";
      mood("anger");
      password.focus();
    }
  })();
});
logout.addEventListener("click", () => {
  if (pending) return;
  const operation = ++generation;
  busy(true);
  detach();
  container.inert = true;
  status.textContent = "Signing out…";
  error.textContent = "";
  void (async () => {
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
      });
      if (operation !== generation) return;
      if (!response.ok && response.status !== 401)
        throw new Error("Logout unavailable");
      signedOut();
    } catch {
      if (operation !== generation) return;
      busy(false);
      status.textContent = "Sign out not confirmed.";
      mood("anger");
      error.textContent = "Could not sign out. Try again.";
    }
  })();
});
retry.addEventListener("click", () => {
  if (!pending) retryAction();
});
window.addEventListener("focus", () => {
  if (!pending && authenticated) void checkSession();
});
void checkSession();
