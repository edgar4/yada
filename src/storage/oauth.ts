import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { abortable } from "../core/abort.js";
import type { McpOAuthStore } from "../connectors/mcp/oauth.js";
import { oauthSessionSchema } from "./oauth-schema.js";
import type { recordStore } from "./records.js";

const recordSchema = oauthSessionSchema.extend({
  lease: z.object({ token: z.string(), expiresAt: z.number() }).optional(),
});
class OAuthBusy extends Error {}
export function createOAuthStore(
  records: ReturnType<typeof recordStore>,
  leaseMs = 30_000,
): McpOAuthStore {
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
      consumePending: (id, pendingState) =>
        records.mutate(key(id), (value) => {
          const current = writable(value);
          const pending = current.pending;
          if (!pending || pending.state !== pendingState)
            return { value: current, result: undefined };
          delete current.pending;
          return { value: current, result: pending };
        }),
    };
  }
  return {
    ...sessionStore(),
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
