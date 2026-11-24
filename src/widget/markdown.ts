const linkPattern =
  /\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/;

function emphasis(text: string): Node[] {
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/;
  return text.split(pattern).map((part, index) => {
    if (index % 2 === 0) return document.createTextNode(part);
    if (part.startsWith("`")) {
      const code = document.createElement("code");
      code.setAttribute("part", "code");
      code.textContent = part.slice(1, -1);
      return code;
    }
    const strong = part.startsWith("**") || part.startsWith("__");
    const node = document.createElement(strong ? "strong" : "em");
    node.append(...emphasis(part.slice(strong ? 2 : 1, strong ? -2 : -1)));
    return node;
  });
}

export function externalLink(url: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = link.host;
  return link;
}

function inline(text: string): Node[] {
  const parts = text.split(linkPattern);
  const nodes: Node[] = [];
  for (let index = 0; index < parts.length; index += 3) {
    nodes.push(...emphasis(parts[index] ?? ""));
    const url = parts[index + 2];
    if (url) {
      const link = externalLink(url);
      link.append(...emphasis(parts[index + 1] ?? ""));
      nodes.push(link);
    }
  }
  return nodes;
}

export function markdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = text.split("\n");
  let paragraph: string[] = [];
  let list: HTMLElement | undefined;
  const flush = () => {
    if (paragraph.length) {
      const p = document.createElement("p");
      p.append(...inline(paragraph.join("\n")));
      fragment.append(p);
    }
    paragraph = [];
    list = undefined;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      while (
        ++index < lines.length &&
        !lines[index]?.trimStart().startsWith("```")
      )
        code.push(lines[index] ?? "");
      const pre = document.createElement("pre");
      pre.className = "code";
      pre.setAttribute("part", "code-block");
      pre.textContent = code.join("\n");
      fragment.append(pre);
    } else if (heading) {
      flush();
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      strong.append(...inline(heading[1] ?? ""));
      p.append(strong);
      fragment.append(p);
    } else if (item) {
      const tag = item[1] ? "ul" : "ol";
      if (list?.tagName.toLowerCase() !== tag) {
        flush();
        list = document.createElement(tag);
        fragment.append(list);
      }
      const li = document.createElement("li");
      li.append(...inline(item[2] ?? ""));
      list.append(li);
    } else if (!line.trim()) flush();
    else {
      list = undefined;
      paragraph.push(line);
    }
  }
  flush();
  return fragment;
}
