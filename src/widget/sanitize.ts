const blockedTags = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "style",
  "template",
  "use",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "foreignobject",
]);
const urlAttributes = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "data",
  "poster",
  "background",
  "ping",
]);
export function safeUrl(url: string): boolean {
  // eslint-disable-next-line no-control-regex
  const compact = url.replace(/[\u0000- \u007f-\u009f]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase();
  return (
    !scheme ||
    ["http", "https", "mailto", "tel", "blob"].includes(scheme) ||
    /^data:image\/(png|jpe?g|gif|webp);/i.test(compact)
  );
}
function cleanElement(element: Element): void {
  for (const { name, value } of [...element.attributes]) {
    const attribute = name.toLowerCase();
    if (
      attribute.startsWith("on") ||
      attribute === "srcdoc" ||
      (urlAttributes.has(attribute) && !safeUrl(value))
    )
      element.removeAttribute(name);
  }
}
export function sanitize<T extends Node>(root: T): T {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  if (root instanceof Element) elements.push(root);
  while (walker.nextNode()) elements.push(walker.currentNode as Element);
  for (const element of elements) {
    if (blockedTags.has(element.localName.toLowerCase())) element.remove();
    else cleanElement(element);
  }
  return root;
}
