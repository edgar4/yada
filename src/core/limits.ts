import { z } from "zod";
import type { Turn } from "./contracts.js";
export const limitsSchema = z
  .strictObject({
    maxContextChars: z.number().int().positive().default(64_000),
    maxCostMicros: z.number().int().nonnegative().optional(),
    costPerCallMicros: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      (value.maxCostMicros === undefined) ===
      (value.costPerCallMicros === undefined),
    "Set both cost limit and per-call reservation",
  );
export type RunLimits = z.input<typeof limitsSchema>;
export function contextWindow(
  history: readonly Turn[],
  maxChars: number,
): Turn[] {
  z.number().int().nonnegative().parse(maxChars);
  let start = history.length;
  let size = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const turn = history[index];
    if (!turn) continue;
    size += JSON.stringify(turn).length;
    if (size > maxChars) break;
    if (turn.role === "user") start = index;
  }
  return history.slice(start);
}
