import { describe, expect, it } from "vitest";
import {
  contentText,
  parseApproval,
  parseEvent,
  parseJob,
  parseJobInput,
  parseSteering,
  ValidationError,
} from "../src/client/validate.js";

const image = { type: "image", mimeType: "image/png", data: "aGk=" };
const job = {
  id: "run",
  profileId: "support",
  input: "Hello",
  createdAt: 1,
  updatedAt: 1,
  status: "queued",
  cancelRequested: false,
  history: [],
  events: [],
};
const event = { version: 1, sequence: 1, type: "usage", at: 1 };

describe("client validation", () => {
  it("describes text and image content", () => {
    expect(contentText("Hi")).toBe("Hi");
    expect(
      contentText([
        { type: "text", text: "Look" },
        { type: "image", mimeType: "image/png", data: "aGk=" },
      ]),
    ).toBe("Look\n[image: image/png]");
  });

  it("accepts content parts and rejects bad images and empty input", () => {
    const parse = (value: unknown) =>
      parseJobInput({ id: "a", profileId: "b", input: value });
    expect(parse([{ type: "text", text: "Hi" }, image]).id).toBe("a");
    for (const bad of [
      "",
      [],
      7,
      [{ ...image, mimeType: "image/svg+xml" }],
      [{ ...image, data: "not base64!" }],
      [{ type: "audio" }],
      [image, image, image, image, image],
      "x".repeat(32_001),
    ])
      expect(() => parse(bad)).toThrow(ValidationError);
    expect(() =>
      parseJobInput({ id: "", profileId: "b", input: "Hi" }),
    ).toThrow("Invalid job input");
    expect(() =>
      parseJobInput({ id: "a", profileId: "b", input: "Hi", extra: 1 }),
    ).toThrow("Invalid job input");
  });

  it("validates steering", () => {
    expect(parseSteering({ id: "a", input: "Hi" }).id).toBe("a");
    expect(() => parseSteering({ id: "a", input: "" })).toThrow(
      "Invalid steering input",
    );
  });

  it("accepts cached usage on events and rejects malformed fields", () => {
    const usage = {
      ...event,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      serverToolCalls: 5,
    };
    expect(parseEvent(usage)).toEqual(usage);
    for (const bad of [
      null,
      [],
      { ...event, version: 2 },
      { ...event, sequence: 0 },
      { ...event, type: "unknown" },
      { ...event, at: Infinity },
      { ...event, text: 1 },
      { ...event, expiresAt: "soon" },
      { ...event, failed: "yes" },
      { ...event, cacheReadTokens: -1 },
      { ...event, serverToolCalls: 1.5 },
    ])
      expect(() => parseEvent(bad)).toThrow("Invalid run event");
  });

  it("fills job defaults and validates history, steering and events", () => {
    expect(parseJob(job)).toMatchObject({
      availableAt: 0,
      attempts: 0,
      steering: [],
    });
    expect(
      parseJob({
        ...job,
        history: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          { role: "tool", toolCallId: "t" },
        ],
        steering: [{ id: "s", input: "Stop", consumed: false }],
        events: [event],
      }).steering,
    ).toHaveLength(1);
    for (const bad of [
      { ...job, createdAt: "now" },
      { ...job, status: "paused" },
      { ...job, cancelRequested: 1 },
      { ...job, history: {} },
      { ...job, history: [{ role: 1 }] },
      { ...job, history: [{ role: "user", content: 1 }] },
      { ...job, steering: {} },
      { ...job, steering: [{ id: "s", input: "Stop" }] },
      { ...job, events: {} },
    ])
      expect(() => parseJob(bad)).toThrow(ValidationError);
    expect(() => parseJob({ ...job, events: [{}] })).toThrow(
      "Invalid run event",
    );
  });

  it("validates approvals", () => {
    const approval = {
      id: "a",
      preview: "p",
      status: "pending",
      expiresAt: 1,
    };
    expect(parseApproval({ ...approval, remember: ["run"] }).id).toBe("a");
    for (const bad of [
      { ...approval, status: "maybe" },
      { ...approval, remember: [1] },
      { ...approval, remember: "run" },
      { ...approval, extra: true },
    ])
      expect(() => parseApproval(bad)).toThrow("Invalid approval");
  });
});
