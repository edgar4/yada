import { oauthSessionSchema } from "./oauth-schema.js";
import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import type { McpOAuthStore, OAuthSession } from "../connectors/mcp/oauth.js";
import { openDatabase } from "./database.js";
import { recordStore } from "./records.js";
import { storageConfig, type StorageConfig } from "./config.js";
export { storageConfigFromEnv } from "./config.js";
export type { StorageConfig } from "./config.js";
export { StorageConflict } from "./records.js";
const messageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
const messagesSchema = z.array(messageSchema);
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
export interface YadaStorage {
  conversations: ConversationStore;
  oauth: McpOAuthStore;
  close: () => Promise<void>;
}
export async function createStorage(
  config: StorageConfig,
): Promise<YadaStorage> {
  const options = storageConfig.parse(config);
  const db = await openDatabase(options);
  const records = recordStore(db, options.encryptionKey);
  const key = (identity: Identity, id: string) =>
    JSON.stringify([
      "conversation",
      identity.tenantId,
      identity.actorId,
      z.string().min(1).parse(id),
    ]);
  const oauthKey = (id: string) => JSON.stringify(["oauth", id]);
  const session = (value: unknown): OAuthSession =>
    value === undefined ? {} : oauthSessionSchema.parse(value);

  return {
    conversations: {
      async load(identity, id) {
        const record = await records.read(key(identity, id));
        return record
          ? {
              revision: record.revision,
              messages: messagesSchema.parse(record.value),
            }
          : undefined;
      },
      async save(identity, id, messages, expectedRevision) {
        z.number().int().nonnegative().parse(expectedRevision);
        return records.write(
          key(identity, id),
          messagesSchema.parse(messages),
          expectedRevision,
        );
      },
    },
    oauth: {
      async load(id) {
        const record = await records.read(oauthKey(id));
        return record ? session(record.value) : undefined;
      },
      update: async (id, patch) =>
        records.mutate(oauthKey(id), (value) => ({
          value: { ...session(value), ...patch },
          result: undefined,
        })),
      consumePending: (id, state) =>
        records.mutate(oauthKey(id), (value) => {
          const current = session(value);
          const pending = current.pending;
          if (!pending || pending.state !== state)
            return { value: current, result: undefined };
          delete current.pending;
          return { value: current, result: pending };
        }),
    },
    close: () => db.destroy(),
  };
}
