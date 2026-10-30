import { createRetention } from "./retention.js";
import { createActionStore, type ActionStore } from "./actions.js";
import { createJobStore, type JobStore } from "./jobs.js";
import {
  createConversationStore,
  type ConversationStore,
} from "./conversations.js";
export type {
  ConversationStore,
  Conversation,
  ConversationMessage,
} from "./conversations.js";
import { createRunStore, type RunStore } from "./runs.js";
import { oauthSessionSchema } from "./oauth-schema.js";
import type { McpOAuthStore, OAuthSession } from "../connectors/mcp/oauth.js";
import { openDatabase } from "./database.js";
import { recordStore } from "./records.js";
import { storageConfig, type StorageConfig } from "./config.js";
export { storageConfigFromEnv } from "./config.js";
export type { StorageConfig } from "./config.js";
export { StorageConflict } from "./records.js";
export interface YadaStorage {
  runs: RunStore;
  jobs: JobStore;
  actions: ActionStore;
  retention: ReturnType<typeof createRetention>;
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
  const oauthKey = (id: string) => JSON.stringify(["oauth", id]);
  const session = (value: unknown): OAuthSession =>
    value === undefined ? {} : oauthSessionSchema.parse(value);

  return {
    runs: createRunStore(records),
    jobs: createJobStore(records),
    actions: createActionStore(records),
    retention: createRetention(records),
    conversations: createConversationStore(records),
    oauth: {
      async load(id) {
        const record = await records.read(oauthKey(id));
        return record ? session(record.value) : undefined;
      },
      update: async (id, patch) =>
        records.mutate(oauthKey(id), (value) => ({
          value: session({ ...session(value), ...patch }),
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
