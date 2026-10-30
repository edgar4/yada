import { BrowserClient, ClientError } from "yada/client";
import {
  defineYadaWidget,
  type YadaWidget,
  type WidgetRunDetail,
} from "yada/widget";

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
let widget: YadaWidget | undefined;
let authenticated = false;
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
  const runId = stored(runKey);
  if (!runId) return;
  status.textContent = "Restoring your conversation…";
  try {
    await current.resume(runId);
    if (widget === current) status.textContent = "Signed in.";
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
    login.hidden = retry.hidden = true;
    chat.hidden = logout.hidden = false;
    container.inert = false;
    status.textContent = "Signed in.";
    busy(false);
    if (opening) await restore();
  } catch {
    if (operation !== generation) return;
    busy(false);
    container.inert = true;
    status.textContent = "Connection unavailable.";
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
        password.focus();
        return;
      }
      await checkSession();
    } catch {
      if (operation !== generation) return;
      busy(false);
      status.textContent = "Sign in to continue.";
      error.textContent = "Could not sign in. Try again.";
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
      error.textContent = "Could not sign out. Try again.";
    }
  })();
});
retry.addEventListener("click", () => {
  if (!pending) retryAction();
});
window.addEventListener("focus", () => {
  if (!pending) void checkSession();
});
void checkSession();
