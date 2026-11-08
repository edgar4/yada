import type { Identity } from "../core/contracts.js";
import type { YadaStorage } from "../storage/index.js";
import { awaitedApprovalId, type Job } from "./contracts.js";

export async function resumeDecided(
  storage: YadaStorage,
  identity: Identity,
  conversationId: string,
  job: Job,
) {
  const approvalId = awaitedApprovalId(job);
  if (
    !approvalId ||
    (await storage.actions.load(identity, approvalId))?.status === "pending"
  )
    return false;
  await storage.jobs.resume(identity, conversationId, job.id, approvalId);
  return true;
}
