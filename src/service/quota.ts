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
const globalKey = JSON.stringify(["quota-global"]);
export const quotaScopeKey = (identity: Identity, quota: QuotaOptions) =>
  JSON.stringify(
    quota.scope === "actor"
      ? ["quota", identity.tenantId, identity.actorId]
      : ["quota", identity.tenantId],
  );
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
          id: runKey,
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
    await store.settle(globalKey, global.windowMs, runKey, 0);
  return denied;
}
export async function settleRun(
  store: QuotaStore,
  identity: Identity,
  quota: QuotaOptions,
  runKey: string,
  micros: number,
) {
  if (quota.globalCostMicros)
    await store.settle(
      globalKey,
      quota.globalCostMicros.windowMs,
      runKey,
      micros,
    );
  if (quota.costMicros)
    await store.settle(
      quotaScopeKey(identity, quota),
      quota.costMicros.windowMs,
      runKey,
      micros,
    );
}
