import { BrowserClient } from "../../src/client/index.js";
import { defineYadaWidget, type YadaWidget } from "../../src/widget/index.js";

const friendly = (field: string) =>
  field
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());

defineYadaWidget();
document.querySelector<YadaWidget>("yada-chat")?.configure({
  client: new BrowserClient({ baseUrl: location.origin }),
  conversationId: document.body.dataset["conversation"] ?? "moss-demo",
  profileId: document.body.dataset["profile"] ?? "garden",
  name: "Moss",
  subtitle: "Your garden helper",
  fill: true,
  colorScheme: "auto",
  suggestions: ["What can I plant now?", "Book a soil test"],
  labels: {
    approve: "Yes, book it",
    decline: "Not now",
    approvalTitle: "Moss would like to do this",
  },
  formatApprovalPreview: (preview) =>
    preview.replace(/^(\w+):/gm, (_, field: string) => `${friendly(field)}:`),
  renderActivity: ({ tool, phase }) =>
    phase === "started" ? `Checking ${tool}…` : null,
  styles: `
    :host {
      --yada-accent: #3a5a1c;
      --yada-button-color: #fffdf5;
      --yada-background: #fffdf5;
      --yada-log-background: #f1efdf;
      --yada-bubble-background: #fffdf5;
      --yada-input-background: #fffdf5;
      --yada-border: #e3dfc9;
      --yada-control-border: #8a9470;
      --yada-focus: #4d7c0f;
      --yada-color: #27331a;
      --yada-title-font: 600 19px/1.2 Georgia, serif;
      --yada-title-size: 19px;
      --yada-empty-opacity: .85;
      --yada-face-background: #3a5a1c;
      --yada-face-color: #f5e9b8;
      --yada-face-dot: #f5e9b8;
    }
  `,
});
