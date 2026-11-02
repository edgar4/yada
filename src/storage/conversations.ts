import { z } from "zod";
import { summaryPrefix, turnSchema } from "../core/checkpoint.js";
import type { Identity, Turn } from "../core/contracts.js";
import type { recordStore } from "./records.js";
import { isTerminal } from "../service/contracts.js";
export const identitySchema = z.strictObject({
  actorId: z.string().min(1),
  tenantId: z.string().min(1),
});
const failureSchema = z.strictObject({
  role: z.literal("failure"),
  code: z.string(),
});
const summarySchema = z.strictObject({
  role: z.literal("summary"),
  content: z.string(),
});
export const messageSchema: z.ZodType<ConversationMessage> = z.preprocess(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    !("toolCalls" in value)
      ? { ...value, toolCalls: [] }
      : value,
  z.union([turnSchema, failureSchema, summarySchema]),
);
export type ConversationMessage =
  | Turn
  | Readonly<{ role: "failure"; code: string }>
  | Readonly<{ role: "summary"; content: string }>;
const isTurn = (message?: ConversationMessage): message is Turn =>
  message?.role !== "failure" && message?.role !== "summary";
export function modelHistory(messages: readonly ConversationMessage[]): Turn[] {
  const start = messages.map((message) => message.role).lastIndexOf("summary");
  const summary = messages[start];
  return [
    ...(summary?.role === "summary"
      ? [{ role: "user" as const, content: summary.content }]
      : []),
    ...messages.slice(start + 1).filter(isTurn),
  ];
}
export type ConversationSummary = Readonly<{ content: string; kept: number }>;
export function summaryOf(
  history: readonly Turn[],
  messages: readonly Turn[],
  turns: readonly Turn[],
): ConversationSummary | undefined {
  const first = messages[0];
  if (
    first?.role !== "user" ||
    typeof first.content !== "string" ||
    !first.content.startsWith(summaryPrefix) ||
    first.content === history[0]?.content
  )
    return undefined;
  return { content: first.content, kept: messages.length - 1 - turns.length };
}
export function withSummary(
  messages: readonly ConversationMessage[],
  summary?: ConversationSummary,
): ConversationMessage[] {
  if (!summary) return [...messages];
  let index = messages.length;
  for (let kept = 0; kept < summary.kept && index > 0;)
    if (isTurn(messages[--index])) kept++;
  return [
    ...messages.slice(0, index),
    { role: "summary", content: summary.content },
    ...messages.slice(index),
  ];
}
export type Conversation = Readonly<{
  revision: number;
  messages: readonly ConversationMessage[];
}>;
export type ConversationOverview = Readonly<{
  id: string;
  updatedAt: number;
  status?: string;
}>;
export interface ConversationQueries {
  list(
    identity: Identity,
    after?: string,
    limit?: number,
  ): Promise<{ conversations: ConversationOverview[]; next?: string }>;
  inspect(
    identity: Identity,
    id: string,
  ): Promise<{ erased: boolean; active: boolean; runIds: string[] }>;
}
export interface ConversationStore {
  load(identity: Identity, id: string): Promise<Conversation | undefined>;
  save(
    identity: Identity,
    id: string,
    messages: readonly ConversationMessage[],
    expectedRevision: number,
  ): Promise<number>;
}
export const conversationKey = (identity: Identity, id: string) =>
  JSON.stringify([
    "conversation",
    identity.tenantId,
    identity.actorId,
    z.string().min(1).parse(id),
  ]);
export const retiredKey = (
  identity: Identity,
  conversationId: string,
  runId: string,
) =>
  JSON.stringify([
    "retired",
    identity.tenantId,
    identity.actorId,
    conversationId,
    runId,
  ]);
export const messagesFrom = (value: unknown) =>
  z
    .array(messageSchema)
    .parse(
      Array.isArray(value)
        ? value
        : z.object({ messages: z.unknown() }).parse(value).messages,
    );
const overviewSchema = z.object({
  id: z.string(),
  identity: identitySchema,
  deleted: z.boolean().default(false),
  retiredRuns: z.array(z.string()).default([]),
  jobs: z.array(
    z.object({ id: z.string(), status: z.string(), updatedAt: z.number() }),
  ),
});
export function createConversationStore(
  records: ReturnType<typeof recordStore>,
): ConversationStore & ConversationQueries {
  return {
    async list(identity, after = "", limit = 50) {
      const conversations: ConversationOverview[] = [];
      let cursor = after;
      for (;;) {
        const rows = await records.scan(
          "conversation",
          cursor,
          100,
          undefined,
          conversationKey(identity, "-"),
        );
        for (const row of rows) {
          cursor = row.id;
          const state = overviewSchema.safeParse(row.value).data;
          if (!state || state.deleted) continue;
          const last = state.jobs.at(-1);
          conversations.push({
            id: state.id,
            updatedAt: last?.updatedAt ?? 0,
            ...(last ? { status: last.status } : {}),
          });
          if (conversations.length === limit)
            return { conversations, next: cursor };
        }
        if (rows.length < 100) return { conversations };
      }
    },
    async inspect(identity, id) {
      const record = await records.read(conversationKey(identity, id));
      const state = overviewSchema.safeParse(record?.value).data;
      return {
        erased: state?.deleted ?? false,
        active: state?.jobs.some((job) => !isTerminal(job.status)) ?? false,
        runIds: [
          ...(state?.jobs.map((job) => job.id) ?? []),
          ...(state?.retiredRuns ?? []),
        ],
      };
    },
    async load(identity, id) {
      const record = await records.read(conversationKey(identity, id));
      if (
        record &&
        z.object({ deleted: z.boolean().optional() }).safeParse(record.value)
          .data?.deleted
      )
        return undefined;
      return record
        ? { revision: record.revision, messages: messagesFrom(record.value) }
        : undefined;
    },
    async save(identity, id, messages, expectedRevision) {
      z.number().int().nonnegative().parse(expectedRevision);
      const key = conversationKey(identity, id);
      const record = await records.read(key);
      if (record && !Array.isArray(record.value))
        throw new Error(
          "Service conversations must be updated through the service",
        );
      return records.write(
        key,
        z.array(messageSchema).parse(messages),
        expectedRevision,
      );
    },
  };
}
