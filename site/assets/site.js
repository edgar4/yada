for (const region of globalThis.document.querySelectorAll(
  ".prose pre, .prose table",
))
  region.tabIndex = 0;

for (const button of globalThis.document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const code = globalThis.document.getElementById(button.dataset.copy);
    const status = globalThis.document.querySelector(".copy-status");
    try {
      await globalThis.navigator.clipboard.writeText(code.textContent);
      if (button.querySelector("svg")) button.classList.add("is-copied");
      else button.textContent = "Copied";
      status.textContent = "Code copied to clipboard.";
    } catch {
      status.textContent = "Copy unavailable. Select the code to copy it.";
    }
  });
}

for (const button of globalThis.document.querySelectorAll(".play-button")) {
  const video = button.previousElementSibling;
  video.controls = false;
  button.hidden = false;
  button.addEventListener("click", () => {
    video.controls = true;
    button.hidden = true;
    video.play();
    video.focus();
  });
}

const showProof = async (key, url, pick) => {
  const item = globalThis.document.querySelector(`[data-proof="${key}"]`);
  if (!item) return;
  let value;
  try {
    value = globalThis.sessionStorage.getItem(`yada-proof-${key}`);
  } catch {
    value = null;
  }
  if (!value) {
    try {
      const response = await globalThis.fetch(url);
      if (!response.ok) return;
      value = pick(await response.json());
    } catch {
      return;
    }
    if (!value) return;
    try {
      globalThis.sessionStorage.setItem(`yada-proof-${key}`, value);
    } catch {
      // Storage can be blocked; the value still renders uncached.
    }
  }
  item.querySelector("span").textContent = value;
  item.hidden = false;
};
showProof(
  "npm",
  "https://registry.npmjs.org/@edgaralochi/yada/latest",
  (data) => typeof data.version === "string" && `v${data.version}`,
);
showProof(
  "stars",
  "https://api.github.com/repos/edgar4/yada",
  (data) =>
    data.stargazers_count > 0 && data.stargazers_count.toLocaleString("en"),
);
