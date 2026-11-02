import type { ContentPart, Turn } from "../core/contracts.js";

export const imageUrlParts = (parts: readonly ContentPart[]) =>
  parts.map((part) =>
    part.type === "text"
      ? part
      : {
          type: "image_url" as const,
          image_url: { url: `data:${part.mimeType};base64,${part.data}` },
        },
  );

export function withTrailingImages<M>(
  turns: readonly Turn[],
  convert: (turn: Turn) => M,
  imageMessage: (images: ContentPart[]) => M,
): M[] {
  const messages: M[] = [];
  let images: ContentPart[] = [];
  const flush = () => {
    if (images.length) messages.push(imageMessage(images));
    images = [];
  };
  for (const turn of turns) {
    if (turn.role !== "tool") flush();
    messages.push(convert(turn));
    if (turn.role === "tool" && typeof turn.content !== "string")
      images.push(...turn.content.filter((part) => part.type === "image"));
  }
  flush();
  return messages;
}

export const uniqueSources = (
  sources: readonly { url: string; title: string }[],
) =>
  sources.filter(
    (source, index) =>
      sources.findIndex((other) => other.url === source.url) === index,
  );
