import { run, runTurns } from "../core/runtime.js";
import type { RunCheckpoint } from "../core/checkpoint.js";
import { modelHistory, type ConversationMessage } from "./conversations.js";
import { StorageConflict } from "./records.js";
import type { ConversationStore } from "./index.js";
export async function runConversation(
  options: Omit<
    Parameters<typeof run>[0],
    "history" | "checkpoint" | "persist"
  > & {
    conversationId: string;
    store: ConversationStore;
  },
) {
  const { conversationId, store, ...runOptions } = options;
  const { identity } = options;
  const previous = await store.load(identity, conversationId);
  const history = modelHistory(previous?.messages ?? []);
  let last: RunCheckpoint | undefined;
  const result = await run({
    ...runOptions,
    history,
    persist: (checkpoint) => {
      last = checkpoint;
      return Promise.resolve();
    },
  });
  let turns: ConversationMessage[];
  if (result.status === "completed")
    turns = (last && runTurns(last.messages, last.steered?.length)) ?? [
      { role: "user", content: options.input },
      { role: "assistant", content: result.text, toolCalls: [] },
    ];
  else if (result.status === "failed" || result.status === "cancelled")
    turns = [
      { role: "user", content: options.input },
      {
        role: "failure",
        code: result.status === "failed" ? result.code : "cancelled",
      },
    ];
  else return result;
  try {
    await store.save(
      identity,
      conversationId,
      [...(previous?.messages ?? []), ...turns],
      previous?.revision ?? 0,
    );
  } catch (error) {
    if (!(error instanceof StorageConflict)) throw error;
    const latest = await store.load(identity, conversationId);
    await store.save(
      identity,
      conversationId,
      [...(latest?.messages ?? []), ...turns],
      latest?.revision ?? 0,
    );
  }
  return result;
}
