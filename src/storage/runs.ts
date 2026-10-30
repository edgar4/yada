import { limitsSchema } from "../core/limits.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  checkpointSchema,
  turnSchema,
  type RunCheckpoint,
} from "../core/checkpoint.js";
import type { Identity } from "../core/contracts.js";
import type { recordStore } from "./records.js";
const requestSchema = z.object({
  input: z.string(),
  limits: limitsSchema.default({ maxContextChars: 64000 }),
  history: z.array(turnSchema).default([]),
  system: z.string(),
  profileId: z.string().min(1),
  provider: z.string(),
  tools: z.array(z.string()),
  maxRounds: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
});
const runSchema = z.object({
  version: z.literal(1),
  request: requestSchema,
  checkpoint: checkpointSchema.optional(),
  lease: z.object({ token: z.string(), expiresAt: z.number() }).optional(),
});
export type DurableRequest = z.input<typeof requestSchema>;
export type DurableRun = z.infer<typeof runSchema>;
export class RunLeaseError extends Error {
  constructor() {
    super("Run is leased or lease has expired");
  }
}
export function requireRunLease(value: unknown, token: string): DurableRun {
  const state = runSchema.parse(value);
  if (state.lease?.token !== token || state.lease.expiresAt <= Date.now())
    throw new RunLeaseError();
  return state;
}
export type RunOwnership = Readonly<{ runId: string; token: string }>;
export function withRunLease<T>(
  records: ReturnType<typeof recordStore>,
  identity: Identity,
  ownership: RunOwnership,
  operation: (
    tx: ReturnType<typeof recordStore>,
    assertOwned: () => void,
  ) => Promise<T>,
): Promise<T> {
  return records.transaction(async (tx) => {
    const key = JSON.stringify([
      "run",
      identity.tenantId,
      identity.actorId,
      ownership.runId,
    ]);
    const run = await tx.read(key);
    if (!run) throw new RunLeaseError();
    const assertOwned = () => {
      requireRunLease(run.value, ownership.token);
    };
    assertOwned();
    await tx.write(key, run.value, run.revision);
    assertOwned();
    return operation(tx, assertOwned);
  });
}
export interface RunStore {
  load(identity: Identity, id: string): Promise<DurableRun | undefined>;
  claim(
    identity: Identity,
    id: string,
    request: DurableRequest,
    leaseMs: number,
  ): Promise<DurableRun>;
  save(
    identity: Identity,
    id: string,
    token: string,
    checkpoint: RunCheckpoint,
    leaseMs: number,
  ): Promise<void>;
  release(identity: Identity, id: string, token: string): Promise<void>;
  renew(
    identity: Identity,
    id: string,
    token: string,
    leaseMs: number,
  ): Promise<void>;
}
export function createRunStore(
  records: ReturnType<typeof recordStore>,
): RunStore {
  const key = (identity: Identity, id: string) =>
    JSON.stringify([
      "run",
      identity.tenantId,
      identity.actorId,
      z.string().min(1).parse(id),
    ]);
  const duration = (value: number) =>
    z.number().int().min(100).max(300_000).parse(value);
  return {
    async load(identity, id) {
      const record = await records.read(key(identity, id));
      return record ? runSchema.parse(record.value) : undefined;
    },
    async claim(identity, id, request, leaseMs) {
      duration(leaseMs);
      const parsed = requestSchema.parse(request);
      const token = randomUUID();
      return records.mutate(key(identity, id), (value) => {
        const state =
          value === undefined
            ? { version: 1 as const, request: parsed }
            : runSchema.parse(value);
        if (JSON.stringify(state.request) !== JSON.stringify(parsed))
          throw new Error("Run configuration mismatch");
        if (state.checkpoint?.outcome) return { value: state, result: state };
        if (state.lease && state.lease.expiresAt > Date.now())
          throw new RunLeaseError();
        const next = {
          ...state,
          lease: { token, expiresAt: Date.now() + leaseMs },
        };
        return { value: next, result: next };
      });
    },
    async save(identity, id, token, checkpoint, leaseMs) {
      duration(leaseMs);
      const parsed = checkpointSchema.parse(checkpoint);
      await records.mutate(key(identity, id), (value) => {
        const state = requireRunLease(value, token);
        return {
          value: {
            ...state,
            checkpoint: parsed,
            lease: { token, expiresAt: Date.now() + leaseMs },
          },
          result: undefined,
        };
      });
    },
    async release(identity, id, token) {
      await records.mutate(key(identity, id), (value) => {
        const state = requireRunLease(value, token);
        return {
          value: { ...state, lease: { token, expiresAt: 0 } },
          result: undefined,
        };
      });
    },
    async renew(identity, id, token, leaseMs) {
      duration(leaseMs);
      await records.mutate(key(identity, id), (value) => {
        const state = requireRunLease(value, token);
        return {
          value: {
            ...state,
            lease: { token, expiresAt: Date.now() + leaseMs },
          },
          result: undefined,
        };
      });
    },
  };
}
