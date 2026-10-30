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

const face = globalThis.document.getElementById("yada-face");
const faces = {
  neutral: {
    l: [30, 32, 45, 46, 60, 60],
    r: [90, 32, 75, 46, 60, 60],
    s: [60, 60, 60, 75, 60, 90],
    d: [60, 60, 9],
  },
  thinking: {
    l: [50, 40, 50, 41, 50, 42],
    r: [74, 40, 74, 41, 74, 42],
    s: [52, 80, 64, 76, 76, 80],
    d: [60, 78, 0],
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
};
if (
  face &&
  !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
) {
  const part = (key) => face.querySelector(`[data-part="${key}"]`);
  const draw = (f) => {
    for (const key of ["l", "r", "s"])
      part(key).setAttribute(
        "d",
        `M${f[key][0]} ${f[key][1]} Q${f[key][2]} ${f[key][3]} ${f[key][4]} ${f[key][5]}`,
      );
    for (const [i, attr] of ["cx", "cy", "r"].entries())
      part("d").setAttribute(attr, f.d[i]);
  };
  const clone = (f) =>
    Object.fromEntries(Object.entries(f).map(([key, v]) => [key, [...v]]));
  let current = clone(faces.neutral);
  const morph = (name) => {
    const from = clone(current);
    const start = globalThis.performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / 320, 1);
      const e = 1 - (1 - t) ** 3;
      for (const key in from)
        current[key] = from[key].map(
          (v, i) => v + (faces[name][key][i] - v) * e,
        );
      draw(current);
      if (t < 1) globalThis.requestAnimationFrame(step);
    };
    globalThis.requestAnimationFrame(step);
  };
  const steps = [...globalThis.document.querySelectorAll("[data-face]")];
  let index = 0;
  const advance = () => {
    for (const item of steps)
      item.classList.toggle("is-active", item === steps[index]);
    morph(steps[index].dataset.face);
    index = (index + 1) % steps.length;
  };
  advance();
  globalThis.setInterval(advance, 2400);
}
