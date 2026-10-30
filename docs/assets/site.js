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
      button.textContent = "Copied";
      status.textContent = "Code copied to clipboard.";
    } catch {
      status.textContent = "Copy unavailable. Select the code to copy it.";
    }
  });
}
