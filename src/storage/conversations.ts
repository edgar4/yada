import { z } from "zod";
import { turnSchema } from "../core/checkpoint.js";
import type { Identity, Turn } from "../core/contracts.js";
import type { recordStore } from "./records.js";
export const identitySchema = z.strictObject({
  actorId: z.string().min(1),
  tenantId: z.string().min(1),
});
const failureSchema = z.strictObject({
  role: z.literal("failure"),
  code: z.string(),
});
export const messageSchema: z.ZodType<ConversationMessage> = z.preprocess(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    !("toolCalls" in value)
      ? { ...value, toolCalls: [] }
      : value,
  z.union([turnSchema, failureSchema]),
);
export type ConversationMessage =
  Turn | Readonly<{ role: "failure"; code: string }>;
export const modelHistory = (messages: readonly ConversationMessage[]) =>
  messages.filter((message): message is Turn => message.role !== "failure");
export type Conversation = Readonly<{
  revision: number;
  messages: readonly ConversationMessage[];
}>;
export interface ConversationStore {
  load(identity: Identity, id: string): Promise<Conversation | undefined>;
  save(
    identity: Identity,
    id: string,
    messages: readonly ConversationMessage[],
    expectedRevision: number,
  ): Promise<number>;
}
export const conversationKey = (identity: Identity, id: string) =>
  JSON.stringify([
    "conversation",
    identity.tenantId,
    identity.actorId,
    z.string().min(1).parse(id),
  ]);
export const messagesFrom = (value: unknown) =>
  z
    .array(messageSchema)
    .parse(
      Array.isArray(value)
        ? value
        : z.object({ messages: z.unknown() }).parse(value).messages,
    );
export function createConversationStore(
  records: ReturnType<typeof recordStore>,
): ConversationStore {
  return {
    async load(identity, id) {
      const record = await records.read(conversationKey(identity, id));
      if (
        record &&
        z.object({ deleted: z.boolean().optional() }).safeParse(record.value)
          .data?.deleted
      )
        return undefined;
      return record
        ? { revision: record.revision, messages: messagesFrom(record.value) }
        : undefined;
    },
    async save(identity, id, messages, expectedRevision) {
      z.number().int().nonnegative().parse(expectedRevision);
      const key = conversationKey(identity, id);
      const record = await records.read(key);
      if (record && !Array.isArray(record.value))
        throw new Error(
          "Service conversations must be updated through the service",
        );
      return records.write(
        key,
        z.array(messageSchema).parse(messages),
        expectedRevision,
      );
    },
  };
}
