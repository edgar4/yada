import type { Identity } from "../core/contracts.js";
import type { QuotaWindow } from "../storage/quota.js";
export type QuotaOptions = Readonly<{
  requests?: QuotaWindow;
  costMicros?: QuotaWindow;
  scope?: "tenant" | "actor";
}>;
export const quotaScopeKey = (identity: Identity, quota: QuotaOptions) =>
  JSON.stringify(
    quota.scope === "actor"
      ? ["quota", identity.tenantId, identity.actorId]
      : ["quota", identity.tenantId],
  );
