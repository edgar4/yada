import { BrowserClient } from "../../src/client/index.js";
import { defineYadaWidget, type YadaWidget } from "../../src/widget/index.js";

defineYadaWidget();
const widget = document.querySelector<YadaWidget>("yada-chat");
widget?.configure({
  client: new BrowserClient({ baseUrl: location.origin }),
  conversationId: document.body.dataset.conversation ?? "demo",
  profileId: document.body.dataset.profile ?? "support",
});
