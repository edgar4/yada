import type { Identity } from "../core/contracts.js";
import type { RunEvent } from "./contracts.js";
export interface EventBus {
  publish(key: string, event: RunEvent): void;
  subscribe(key: string, listener: (event: RunEvent) => void): () => void;
}
export const eventKey = (
  identity: Identity,
  conversationId: string,
  runId: string,
) =>
  JSON.stringify([identity.tenantId, identity.actorId, conversationId, runId]);
export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(event: RunEvent) => void>>();
  return {
    publish(key, event) {
      for (const listener of listeners.get(key) ?? []) listener(event);
    },
    subscribe(key, listener) {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
  };
}
