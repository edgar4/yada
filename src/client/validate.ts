import type { Approval, Job, JobInput, RunEvent } from "./index.js";

const mimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const maxImageChars = Math.ceil((5 * 1024 * 1024) / 3) * 4;
const statuses = [
  "queued",
  "running",
  "progress",
  "awaiting_approval",
  "reconciling",
  "completed",
  "failed",
  "cancelled",
];
const eventTypes = [
  ...statuses,
  "tool_started",
  "tool_finished",
  "usage",
  "steering_received",
  "text_delta",
];
const approvalStatuses = [
  "pending",
  "approved",
  "declined",
  "executing",
  "completed",
  "expired",
  "unknown",
  "undelivered",
];

type Obj = Record<string, unknown>;
export class ValidationError extends Error {}
const fail = (what: string): never => {
  throw new ValidationError(`Invalid ${what}`);
};
const check = (ok: boolean, what: string) => {
  if (!ok) fail(what);
};
const obj = (value: unknown, what: string, keys?: string[]): Obj => {
  check(
    typeof value === "object" && value !== null && !Array.isArray(value),
    what,
  );
  const record = value as Obj;
  if (keys)
    check(
      Object.keys(record).every((key) => keys.includes(key)),
      what,
    );
  return record;
};
const str = (value: unknown, what: string, max = Infinity) => {
  check(typeof value === "string" && value.length <= max, what);
};
const id = (value: unknown, what: string) => {
  str(value, what, 128);
  check(value !== "", what);
};
const num = (value: unknown, what: string) => {
  check(typeof value === "number" && Number.isFinite(value), what);
};
const optional = (record: Obj, key: string, test: (value: unknown) => void) => {
  if (record[key] !== undefined) test(record[key]);
};

export const contentText = (content: JobInput["input"]) =>
  typeof content === "string"
    ? content
    : content
        .map((part) =>
          part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
        )
        .join("\n");

function content(value: unknown, what: string, limit: number) {
  if (typeof value === "string") {
    str(value, what, limit);
    return;
  }
  check(Array.isArray(value), what);
  let text = 0;
  let images = 0;
  for (const part of value as unknown[]) {
    const item = obj(part, what);
    if (item["type"] === "text") {
      str(item["text"], what);
      text += (item["text"] as string).length;
    } else {
      images++;
      check(item["type"] === "image", what);
      check(mimeTypes.includes(item["mimeType"] as string), what);
      str(item["data"], what, maxImageChars);
      check(/^[A-Za-z0-9+/]*={0,2}$/.test(item["data"] as string), what);
    }
  }
  check(images <= 4 && text <= limit, what);
}

function input(value: unknown, what: string) {
  content(value, what, 32_000);
  check(value !== "" && !(Array.isArray(value) && !value.length), what);
}

export function parseJobInput(value: unknown): JobInput {
  const record = obj(value, "job input", ["id", "profileId", "input"]);
  id(record["id"], "job input");
  id(record["profileId"], "job input");
  input(record["input"], "job input");
  return record as JobInput;
}

export function parseSteering(value: unknown) {
  const record = obj(value, "steering input", ["id", "input"]);
  id(record["id"], "steering input");
  input(record["input"], "steering input");
  return record as { id: string; input: JobInput["input"] };
}

export function parseEvent(value: unknown): RunEvent {
  const record = obj(value, "run event");
  check(record["version"] === 1, "run event");
  check(
    Number.isInteger(record["sequence"]) && (record["sequence"] as number) > 0,
    "run event",
  );
  check(eventTypes.includes(record["type"] as string), "run event");
  num(record["at"], "run event");
  for (const key of ["text", "code", "approvalId", "tool"])
    optional(record, key, (item) => {
      str(item, "run event");
    });
  optional(record, "expiresAt", (item) => {
    num(item, "run event");
  });
  optional(record, "failed", (item) => {
    check(typeof item === "boolean", "run event");
  });
  for (const key of ["inputTokens", "outputTokens"])
    optional(record, key, (item) => {
      check(Number.isInteger(item) && (item as number) >= 0, "run event");
    });
  return record as RunEvent;
}

export function parseJob(value: unknown): Job {
  const record = obj(value, "job");
  parseJobInput({
    id: record["id"],
    profileId: record["profileId"],
    input: record["input"],
  });
  num(record["createdAt"], "job");
  num(record["updatedAt"], "job");
  check(statuses.includes(record["status"] as string), "job");
  check(typeof record["cancelRequested"] === "boolean", "job");
  check(Array.isArray(record["history"]), "job");
  for (const turn of record["history"] as unknown[]) {
    const item = obj(turn, "job");
    str(item["role"], "job");
    if (item["role"] === "user" || item["role"] === "assistant")
      content(item["content"], "job", Infinity);
  }
  const steering = record["steering"] ?? [];
  check(Array.isArray(steering), "job");
  for (const item of steering as unknown[]) {
    const { id, input } = obj(item, "job");
    parseSteering({ id, input });
    check(typeof obj(item, "job")["consumed"] === "boolean", "job");
  }
  check(Array.isArray(record["events"]), "job");
  for (const event of record["events"] as unknown[]) parseEvent(event);
  return {
    availableAt: 0,
    attempts: 0,
    ...record,
    steering,
  } as Job;
}

export function parseApproval(value: unknown): Approval {
  const record = obj(value, "approval", [
    "id",
    "preview",
    "status",
    "expiresAt",
    "remember",
  ]);
  str(record["id"], "approval");
  str(record["preview"], "approval");
  check(approvalStatuses.includes(record["status"] as string), "approval");
  num(record["expiresAt"], "approval");
  check(
    record["remember"] === undefined ||
      (Array.isArray(record["remember"]) &&
        record["remember"].every((scope) => typeof scope === "string")),
    "approval",
  );
  return record as Approval;
}
