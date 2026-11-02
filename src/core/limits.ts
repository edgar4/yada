import { z } from "zod";
import { contentSize } from "./content.js";
import type { Turn } from "./contracts.js";
export const limitsSchema = z
  .strictObject({
    maxContextChars: z.number().int().positive().default(256_000),
    maxRounds: z.number().int().positive().default(32),
    maxToolCalls: z.number().int().positive().default(64),
    maxFailures: z.number().int().positive().default(3),
    maxParallelTools: z.number().int().positive().default(4),
    maxToolOutput: z.number().int().positive().default(32_000),
    maxCostMicros: z.number().int().nonnegative().optional(),
    costPerCallMicros: z.number().int().positive().optional(),
    pricing: z
      .strictObject({
        inputMicrosPer1k: z.number().nonnegative(),
        outputMicrosPer1k: z.number().nonnegative(),
        cacheReadMicrosPer1k: z.number().nonnegative().optional(),
        cacheWriteMicrosPer1k: z.number().nonnegative().optional(),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.costPerCallMicros === undefined ||
      value.maxCostMicros !== undefined,
    "Per-call reservation needs a cost limit",
  )
  .refine(
    (value) =>
      value.maxCostMicros === undefined ||
      value.costPerCallMicros !== undefined ||
      value.pricing !== undefined,
    "Cost limit needs a per-call reservation or pricing",
  );
export type RunLimits = z.input<typeof limitsSchema>;
export function usageCostMicros(
  pricing: NonNullable<RunLimits["pricing"]>,
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  }>,
): number {
  const { cacheReadTokens = 0, cacheWriteTokens = 0 } = usage;
  return (
    ((usage.inputTokens - cacheReadTokens - cacheWriteTokens) *
      pricing.inputMicrosPer1k +
      cacheReadTokens *
        (pricing.cacheReadMicrosPer1k ?? pricing.inputMicrosPer1k) +
      cacheWriteTokens *
        (pricing.cacheWriteMicrosPer1k ?? pricing.inputMicrosPer1k) +
      usage.outputTokens * pricing.outputMicrosPer1k) /
    1000
  );
}
const compactedNote = (turn: Extract<Turn, { role: "tool" }>) =>
  `[compacted: ${String(contentSize(turn.content))} chars]`;
const compact = (turn: Extract<Turn, { role: "tool" }>): Turn => {
  const content = compactedNote(turn);
  return content.length < contentSize(turn.content)
    ? { ...turn, content }
    : turn;
};
export function compactOldest(messages: Turn[], excess: number): number {
  const latest = messages.map((turn) => turn.role).lastIndexOf("assistant");
  let saved = 0;
  for (let index = 0; index < latest && saved < excess; index++) {
    const turn = messages[index];
    if (turn?.role !== "tool") continue;
    const next = compact(turn);
    saved += JSON.stringify(turn).length - JSON.stringify(next).length;
    messages[index] = next;
  }
  return saved;
}
export function contextWindow(
  history: readonly Turn[],
  maxChars: number,
  toolChars = 16_000,
): Turn[] {
  z.number().int().nonnegative().parse(maxChars);
  let toolSize = 0;
  const turns = [...history];
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn?.role !== "tool") continue;
    toolSize += contentSize(turn.content);
    if (toolSize > toolChars) turns[index] = compact(turn);
  }
  let start = turns.length;
  let size = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (!turn) continue;
    size += JSON.stringify(turn).length;
    if (size > maxChars) break;
    if (turn.role === "user") start = index;
  }
  return turns.slice(start);
}
