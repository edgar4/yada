import { run } from "../core/runtime.js";
import type { Turn } from "../core/contracts.js";
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
  const previous = await store.load(options.identity, conversationId);
  const messages = previous?.messages ?? [];
  const history: Turn[] = messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content }
      : { role: "assistant", content: message.content, toolCalls: [] },
  );
  const result = await run({ ...runOptions, history });
  if (result.status === "completed")
    await store.save(
      options.identity,
      conversationId,
      [
        ...messages,
        { role: "user", content: options.input },
        { role: "assistant", content: result.text },
      ],
      previous?.revision ?? 0,
    );
  return result;
}
