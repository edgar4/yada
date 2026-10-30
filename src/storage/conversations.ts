import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import type { recordStore } from "./records.js";
export const identitySchema = z.strictObject({
  actorId: z.string().min(1),
  tenantId: z.string().min(1),
});
export const messageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type ConversationMessage = z.infer<typeof messageSchema>;
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
