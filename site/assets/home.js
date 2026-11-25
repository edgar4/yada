const doc = globalThis.document;
const reduce = globalThis.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
const byId = (id) => doc.getElementById(id);

const faces = {
  neutral: [
    30, 32, 45, 46, 60, 60, 90, 32, 75, 46, 60, 60, 60, 60, 60, 75, 60, 90, 60,
    60, 9,
  ],
  smile: [
    44, 42, 44, 48, 44, 54, 76, 42, 76, 48, 76, 54, 40, 72, 60, 92, 80, 72, 60,
    80, 0,
  ],
  wink: [
    44, 42, 44, 48, 44, 54, 67, 52, 76, 38, 85, 52, 42, 74, 62, 90, 80, 70, 60,
    80, 0,
  ],
};
const sticker = byId("hero-face");
const strokes = sticker.querySelectorAll("path");
const dot = sticker.querySelector("circle");
let face = [...faces.neutral];
const draw = () => {
  strokes.forEach((path, i) => {
    const [a, b, c, d, e, f] = face.slice(i * 6, i * 6 + 6);
    path.setAttribute("d", `M${a} ${b} Q${c} ${d} ${e} ${f}`);
  });
  dot.setAttribute("cx", face[18]);
  dot.setAttribute("cy", face[19]);
  dot.setAttribute("r", Math.max(0, face[20]));
};
const morph = (name, ms = 300) => {
  const from = [...face];
  const to = faces[name];
  if (reduce) {
    face = [...to];
    draw();
    return;
  }
  const start = globalThis.performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / ms, 1);
    const eased = 1 - (1 - t) ** 3;
    face = from.map((v, i) => v + (to[i] - v) * eased);
    draw();
    if (t < 1) globalThis.requestAnimationFrame(step);
  };
  globalThis.requestAnimationFrame(step);
};
const wink = () => {
  morph("wink", 200);
  globalThis.setTimeout(() => morph("smile", 260), 650);
};
globalThis.setTimeout(() => morph("smile", 500), 900);
if (!reduce) globalThis.setInterval(wink, 5000);

const choice = (yesId, noId, yesLabel, onYes, onNo) => {
  const yes = byId(yesId);
  const no = byId(noId);
  yes.addEventListener("click", () => {
    yes.textContent = "Approved ✓";
    no.textContent = "Decline";
    onYes?.();
  });
  no.addEventListener("click", () => {
    no.textContent = "Declined ✓";
    yes.textContent = yesLabel;
    onNo?.();
  });
};
const receipt = byId("hero-receipt");
choice(
  "hero-yes",
  "hero-no",
  "Approve",
  () => {
    receipt.classList.add("is-on");
    wink();
  },
  () => receipt.classList.remove("is-on"),
);
choice("tile-yes", "tile-no", "Approve change");

const providers = [
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "ollama",
  "llamacpp",
];
const provider = byId("provider-name");
let current = 0;
if (!reduce)
  globalThis.setInterval(() => {
    current = (current + 1) % providers.length;
    provider.textContent = providers[current];
  }, 2200);

const feed = byId("feed");
const note = byId("note");
const noteField = byId("note-field");
const script = [
  ["bubble user", "Add “leave at the side door” to this order."],
  ["tool-chip", "order_lookup → #1042 · Ready to ship"],
  ["bubble bot", "Found it. This changes the order, so I need your OK:"],
  ["approval"],
  ["ok-line", "✓ receipt rcpt_8f2a · note saved"],
  ["bubble bot", "Done. It's on the courier's label now."],
];
let timer;
const play = () => {
  globalThis.clearTimeout(timer);
  feed.replaceChildren();
  note.textContent = "None";
  noteField.classList.remove("is-flash");
  let index = 0;
  const next = () => {
    if (index >= script.length) return;
    const [kind, text] = script[index++];
    if (kind === "approval") {
      const card = doc.createElement("div");
      card.className = "mini-approval";
      card.innerHTML =
        '<p>Update delivery note</p><div class="row"><button class="btn btn-ink" type="button">Approve</button><button class="btn btn-line" type="button">Decline</button></div>';
      feed.append(card);
      const [approve, decline] = card.querySelectorAll("button");
      approve.addEventListener("click", () => {
        approve.textContent = "Approved ✓";
        decline.remove();
        note.textContent = "Leave at the side door";
        noteField.classList.add("is-flash");
        timer = globalThis.setTimeout(next, 500);
      });
      decline.addEventListener("click", () => {
        decline.textContent = "Declined ✓";
        approve.remove();
      });
      return;
    }
    const line = doc.createElement("p");
    line.className = kind;
    line.textContent = text;
    feed.append(line);
    timer = globalThis.setTimeout(next, 850);
  };
  next();
};
byId("replay").addEventListener("click", play);
if (reduce) play();
else
  new globalThis.IntersectionObserver(
    (entries, observer) => {
      if (!entries[0].isIntersecting) return;
      play();
      observer.disconnect();
    },
    { threshold: 0.4 },
  ).observe(doc.querySelector(".shop"));

const installs = {
  sh: '<span class="nb">curl</span> <span class="k">-fsSL</span> <span class="s">https://yada.edgar.co.ke/install.sh</span> <span class="o">|</span> <span class="nb">sh</span>',
  win: '<span class="nb">irm</span> <span class="s">https://yada.edgar.co.ke/install.ps1</span> <span class="o">|</span> <span class="nb">iex</span>',
  brew: '<span class="nb">brew</span> <span class="k">tap</span> <span class="s">edgar4/yada</span> <span class="o">&amp;&amp;</span> <span class="nb">brew</span> <span class="k">install</span> yada',
};
const tabs = doc.querySelector(".tabs");
const installCode = byId("terminal-install-code");
tabs.hidden = false;
for (const tab of tabs.querySelectorAll("button"))
  tab.addEventListener("click", () => {
    for (const other of tabs.querySelectorAll("button"))
      other.setAttribute("aria-pressed", String(other === tab));
    installCode.innerHTML = installs[tab.dataset.os];
  });
