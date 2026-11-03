import { z } from "zod";
import type { Content, ContentPart, Turn } from "./contracts.js";
export const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const maxImageChars = Math.ceil((5 * 1024 * 1024) / 3) * 4;
export const maxImages = 4;
const isImage = (part: ContentPart) => part.type === "image";
export const imagePartSchema = z.strictObject({
  type: z.literal("image"),
  mimeType: z.enum(imageTypes),
  data: z.base64().max(maxImageChars),
});
export const contentSchema = z.union([
  z.string(),
  z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("text"), text: z.string() }),
        imagePartSchema,
      ]),
    )
    .refine(
      (parts) => parts.filter(isImage).length <= maxImages,
      "Too many images",
    ),
]);
export const hasImages = (content: Content) =>
  typeof content !== "string" && content.some(isImage);
export const contentText = (content: Content): string =>
  typeof content === "string"
    ? content
    : content
        .map((part) =>
          part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
        )
        .join("\n");
export const imageChars = 6400;
const imageSavings = (content: Content) =>
  typeof content === "string"
    ? 0
    : content.reduce(
        (sum, part) =>
          part.type === "image" ? sum + part.data.length - imageChars : sum,
        0,
      );
export const contentSize = (content: Content) =>
  (typeof content === "string"
    ? content.length
    : JSON.stringify(content).length) - imageSavings(content);
export const turnSize = (turn: Turn) =>
  JSON.stringify(turn).length - imageSavings(turn.content);
export const messagesSize = (messages: readonly Turn[]) =>
  JSON.stringify(messages).length -
  messages.reduce((sum, turn) => sum + imageSavings(turn.content), 0);
export const omitImages = (content: Content): Content =>
  typeof content === "string"
    ? content
    : content.map((part) =>
        part.type === "image"
          ? { type: "text" as const, text: "[image omitted]" }
          : part,
      );
export async function mapText(
  content: Content,
  change: (text: string) => Promise<string> | string,
): Promise<Content> {
  if (typeof content === "string") return change(content);
  const parts: ContentPart[] = [];
  for (const part of content)
    parts.push(
      part.type === "text" ? { ...part, text: await change(part.text) } : part,
    );
  return parts;
}
