import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { abortable } from "../core/abort.js";
import type { McpOAuthStore } from "../connectors/mcp/oauth.js";
import type { Identity } from "../core/contracts.js";
import { oauthSessionSchema } from "./oauth-schema.js";
import type { recordStore } from "./records.js";

const recordSchema = oauthSessionSchema.extend({
  lease: z.object({ token: z.string(), expiresAt: z.number() }).optional(),
});
class OAuthBusy extends Error {}
export type OAuthRecordStore = McpOAuthStore & {
  eraseActor(identity: Identity): Promise<void>;
  prune(): Promise<number>;
};
export function createOAuthStore(
  records: ReturnType<typeof recordStore>,
  leaseMs = 30_000,
): OAuthRecordStore {
  z.number().int().min(100).max(300_000).parse(leaseMs);
  const key = (id: string) => JSON.stringify(["oauth", id]);
  const state = (value: unknown) => recordSchema.parse(value ?? {});
  const lost = () => new Error("OAuth coordination lost");
  const owned = (value: unknown, token: string) => {
    const current = state(value);
    if (current.lease?.token !== token || current.lease.expiresAt <= Date.now())
      throw lost();
    return current;
  };
  async function* allRows() {
    for (let after = ""; ;) {
      const rows = await records.scan("oauth", after);
      yield* rows;
      if (rows.length < 100) return;
      after = rows[rows.length - 1]?.id ?? "";
    }
  }
  function sessionStore(token?: string): McpOAuthStore {
    const writable = (value: unknown) => {
      const current = token === undefined ? state(value) : owned(value, token);
      if (
        token === undefined &&
        current.lease &&
        current.lease.expiresAt > Date.now()
      )
        throw lost();
      return current;
    };
    return {
      async load(id) {
        const record = await records.read(key(id));
        if (token !== undefined) owned(record?.value, token);
        return record ? oauthSessionSchema.parse(record.value) : undefined;
      },
      update: (id, patch) =>
        records.mutate(key(id), (value) => {
          const current = writable(value);
          return {
            value: {
              ...oauthSessionSchema.parse({ ...current, ...patch }),
              ...(current.lease ? { lease: current.lease } : {}),
            },
            result: undefined,
          };
        }),
      async consumePending(id, pendingState) {
        const record = await records.read(key(id));
        if (token !== undefined) owned(record?.value, token);
        if (state(record?.value).pending?.state !== pendingState)
          return undefined;
        return records.mutate(key(id), (value) => {
          const current = writable(value);
          const pending = current.pending;
          if (!pending || pending.state !== pendingState)
            return { value: current, result: undefined };
          delete current.pending;
          return { value: current, result: pending };
        });
      },
      remove: (id) => records.remove(key(id)),
    };
  }
  return {
    ...sessionStore(),
    async eraseActor({ tenantId, actorId }: Identity) {
      await records.removeScope(
        "oauth",
        key(JSON.stringify([tenantId, actorId])),
      );
      // Connect-state rows are keyed by the state alone, so only their contents name the actor.
      const prefix = JSON.stringify({ tenantId, actorId }).slice(0, -1);
      for await (const { id, revision, value } of allRows())
        if (state(value).pending?.state.startsWith(prefix))
          await records.removeRow(id, revision);
    },
    async prune() {
      const now = Date.now();
      let removed = 0;
      for await (const { id, revision, value } of allRows()) {
        const { tokens, client, pending, lease } = state(value);
        if (
          !tokens &&
          !client &&
          !(pending && pending.expiresAt > now) &&
          !(lease && lease.expiresAt > now) &&
          (await records.removeRow(id, revision))
        )
          removed++;
      }
      return removed;
    },
    async coordinate(id, operation, signal = AbortSignal.timeout(10_000)) {
      const token = randomUUID();
      for (;;) {
        signal.throwIfAborted();
        try {
          await records.mutate(key(id), (value) => {
            const current = state(value);
            if (current.lease && current.lease.expiresAt > Date.now())
              throw new OAuthBusy();
            return {
              value: {
                ...current,
                lease: { token, expiresAt: Date.now() + leaseMs },
              },
              result: undefined,
            };
          });
          break;
        } catch (error) {
          if (error instanceof OAuthBusy) {
            await delay(25, undefined, { signal });
            continue;
          }
        }
        throw new Error("OAuth coordination unavailable");
      }
      const controller = new AbortController();
      const activeSignal = AbortSignal.any([signal, controller.signal]);
      let active = true;
      let renewal: Promise<void> | undefined;
      const timer = setInterval(
        () => {
          if (renewal) return;
          renewal = records
            .mutate(key(id), (value) => {
              const current = owned(value, token);
              return {
                value: {
                  ...current,
                  lease: { token, expiresAt: Date.now() + leaseMs },
                },
                result: undefined,
              };
            })
            .catch(() => {
              controller.abort();
            })
            .finally(() => {
              renewal = undefined;
            });
        },
        Math.floor(leaseMs / 3),
      );
      const scoped = sessionStore(token);
      const guarded: McpOAuthStore = {
        load: (target) => check(target, () => scoped.load(target)),
        update: (target, patch) =>
          check(target, () => scoped.update(target, patch)),
        consumePending: (target, pending) =>
          check(target, () => scoped.consumePending(target, pending)),
      };
      async function check<T>(target: string, action: () => Promise<T>) {
        if (!active || activeSignal.aborted || target !== id) throw lost();
        return action();
      }
      try {
        const result = await abortable(
          () => operation(guarded, activeSignal),
          activeSignal,
        );
        activeSignal.throwIfAborted();
        await records.mutate(key(id), (value) => ({
          value: owned(value, token),
          result: undefined,
        }));
        return result;
      } finally {
        active = false;
        clearInterval(timer);
        await renewal;
        await records
          .mutate(key(id), (value) => {
            const current = state(value);
            if (current.lease?.token !== token) throw lost();
            delete current.lease;
            return { value: current, result: undefined };
          })
          .catch(() => undefined);
      }
    },
  };
}
