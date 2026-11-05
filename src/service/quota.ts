import { setTimeout as delay } from "node:timers/promises";
import type { Identity } from "../core/contracts.js";
import type { QuotaStore, QuotaWindow } from "../storage/quota.js";
export type QuotaOptions = Readonly<{
  requests?: QuotaWindow;
  costMicros?: QuotaWindow;
  scope?: "tenant" | "actor";
  globalCostMicros?: QuotaWindow;
  reserveCostMicros?: number | ((profileId: string) => number);
  reservationTtlMs?: number;
}>;
export const quotaSnapshot = (quota: QuotaOptions, profileId: string) => {
  const reserve =
    typeof quota.reserveCostMicros === "function"
      ? quota.reserveCostMicros(profileId)
      : quota.reserveCostMicros;
  return {
    ...quota,
    ...(reserve === undefined ? {} : { reserveCostMicros: reserve }),
  } as QuotaOptions & { reserveCostMicros?: number };
};
const globalKey = JSON.stringify(["quota-global"]);
export const quotaScopeKey = (identity: Identity, quota: QuotaOptions) =>
  JSON.stringify(
    quota.scope === "actor"
      ? ["quota", identity.tenantId, identity.actorId]
      : ["quota", identity.tenantId],
  );
const holdId = (identity: Identity, runKey: string) =>
  JSON.stringify([identity.tenantId, identity.actorId, runKey]);
export async function admitRun(
  store: QuotaStore,
  identity: Identity,
  quota: QuotaOptions,
  runKey: string,
  profileId: string,
) {
  const micros =
    typeof quota.reserveCostMicros === "function"
      ? quota.reserveCostMicros(profileId)
      : quota.reserveCostMicros;
  const reservation =
    micros === undefined
      ? undefined
      : {
          id: holdId(identity, runKey),
          micros,
          ttlMs: quota.reservationTtlMs ?? 3_600_000,
        };
  const { globalCostMicros: global } = quota;
  if (global) {
    const denied = await store.consume(
      globalKey,
      { costMicros: global },
      reservation,
    );
    if (denied) return denied;
  }
  const denied = await store.consume(
    quotaScopeKey(identity, quota),
    quota,
    reservation,
  );
  if (denied && global && reservation)
    await store.settle(globalKey, global.windowMs, holdId(identity, runKey), 0);
  return denied;
}
async function retried(operation: () => Promise<void>) {
  for (let attempt = 1; ; attempt++)
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      await delay(200 * attempt);
    }
}
export async function settleRun(
  store: QuotaStore,
  identity: Identity,
  quota: QuotaOptions,
  runKey: string,
  micros: number,
) {
  const id = holdId(identity, runKey);
  const settle = (scopeKey: string, { windowMs }: QuotaWindow) =>
    retried(() => store.settle(scopeKey, windowMs, id, micros));
  const results = await Promise.allSettled([
    ...(quota.globalCostMicros
      ? [settle(globalKey, quota.globalCostMicros)]
      : []),
    ...(quota.costMicros
      ? [settle(quotaScopeKey(identity, quota), quota.costMicros)]
      : []),
  ]);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}
