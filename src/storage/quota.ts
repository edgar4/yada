import { z } from "zod";
import type { recordStore } from "./records.js";
export type QuotaWindow = Readonly<{ limit: number; windowMs: number }>;
export interface QuotaStore {
  consume(
    scopeKey: string,
    quota: Readonly<{ requests?: QuotaWindow; costMicros?: QuotaWindow }>,
  ): Promise<{ retryAfterMs: number } | undefined>;
  addCost(scopeKey: string, windowMs: number, micros: number): Promise<void>;
}
const counterSchema = z.object({ start: z.number(), used: z.number() });
const storedSchema = z.object({
  requests: counterSchema.optional(),
  cost: counterSchema.optional(),
});
const current = (
  counter: z.infer<typeof counterSchema> | undefined,
  windowMs: number,
  now: number,
) =>
  counter && now < counter.start + windowMs ? counter : { start: now, used: 0 };
export function createQuotaStore(
  records: ReturnType<typeof recordStore>,
): QuotaStore {
  return {
    consume: (scopeKey, quota) =>
      records.mutate(scopeKey, (value) => {
        const now = Date.now();
        const stored = storedSchema.parse(value ?? {});
        const requests = quota.requests
          ? current(stored.requests, quota.requests.windowMs, now)
          : undefined;
        const cost = quota.costMicros
          ? current(stored.cost, quota.costMicros.windowMs, now)
          : undefined;
        const wait = (counter: typeof cost, window: QuotaWindow | undefined) =>
          counter && window && counter.used >= window.limit
            ? counter.start + window.windowMs - now
            : undefined;
        const retryAfterMs = Math.max(
          wait(cost, quota.costMicros) ?? 0,
          wait(requests, quota.requests) ?? 0,
        );
        if (retryAfterMs > 0)
          return { value: { requests, cost }, result: { retryAfterMs } };
        return {
          value: {
            requests: requests && { ...requests, used: requests.used + 1 },
            cost,
          },
          result: undefined,
        };
      }),
    addCost: async (scopeKey, windowMs, micros) => {
      await records.mutate(scopeKey, (value) => {
        const cost = current(
          storedSchema.parse(value ?? {}).cost,
          windowMs,
          Date.now(),
        );
        return {
          value: {
            ...storedSchema.parse(value ?? {}),
            cost: { ...cost, used: cost.used + micros },
          },
          result: undefined,
        };
      });
    },
  };
}
