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
import { createOAuthStore } from "./oauth.js";
import type { McpOAuthStore } from "../connectors/mcp/oauth.js";
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
  return {
    runs: createRunStore(records),
    jobs: createJobStore(records),
    actions: createActionStore(records),
    conversations: createConversationStore(records),
    oauth: createOAuthStore(records),
    close: () => db.destroy(),
  };
}
