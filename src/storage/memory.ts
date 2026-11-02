import { z } from "zod";
import type { Identity } from "../core/contracts.js";
import type { MemoryStore } from "../core/memory.js";
import type { recordStore } from "./records.js";
export const memoryLimits = {
  itemBytes: 4096,
  items: 200,
  totalBytes: 262_144,
};
export const memoryItemSchema = z.strictObject({
  key: z.string().min(1).max(200),
  text: z.string().min(1),
  tags: z.array(z.string().min(1).max(64)).max(16).default([]),
});
const storedSchema = z.object({
  items: z.array(memoryItemSchema.extend({ updatedAt: z.number() })),
});
export const memoryKey = (identity: Identity) =>
  JSON.stringify(["memory", identity.tenantId, identity.actorId]);
const size = (item: z.output<typeof memoryItemSchema>) =>
  Buffer.byteLength(item.key + item.text + item.tags.join(""));
export function createMemoryStore(
  records: ReturnType<typeof recordStore>,
): MemoryStore {
  const load = async (identity: Identity) =>
    storedSchema.parse(
      (await records.read(memoryKey(identity)))?.value ?? { items: [] },
    ).items;
  return {
    async put(identity, input) {
      const item = memoryItemSchema.parse(input);
      if (size(item) > memoryLimits.itemBytes)
        throw new Error("Memory item is too large");
      await records.mutate(memoryKey(identity), (value) => {
        const others = storedSchema
          .parse(value ?? { items: [] })
          .items.filter((existing) => existing.key !== item.key);
        if (others.length >= memoryLimits.items)
          throw new Error("Memory item limit reached");
        if (
          others.reduce((sum, existing) => sum + size(existing), size(item)) >
          memoryLimits.totalBytes
        )
          throw new Error("Memory storage limit reached");
        return {
          value: { items: [...others, { ...item, updatedAt: Date.now() }] },
          result: undefined,
        };
      });
    },
    async get(identity, key) {
      return (await load(identity)).find((item) => item.key === key);
    },
    async list(identity) {
      return load(identity);
    },
    async delete(identity, key) {
      return records.mutate(memoryKey(identity), (value) => {
        const items = storedSchema.parse(value ?? { items: [] }).items;
        const kept = items.filter((item) => item.key !== key);
        return {
          value: { items: kept },
          result: kept.length !== items.length,
        };
      });
    },
    async search(identity, query, limit = 10) {
      const needle = query.toLowerCase();
      return (await load(identity))
        .filter(
          (item) =>
            item.key.toLowerCase().includes(needle) ||
            item.text.toLowerCase().includes(needle) ||
            item.tags.some((tag) => tag.toLowerCase() === needle),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, Math.max(0, limit));
    },
  };
}
