import { expect, it, vi } from "vitest";
import { storageFixture } from "./helpers/storage.js";
import { createWorker } from "../src/service/worker.js";
import { createFakeProvider } from "../src/providers/fake.js";

it.each(["throw", "reject"])(
  "isolates telemetry callbacks that %s",
  async (failure) => {
    const s = await storageFixture("sqlite");
    await s.storage.jobs.submit(s.identity, "chat", {
      id: "one",
      profileId: "v1",
      input: "Hello",
    });
    const trace = vi.fn(() => {
      if (failure === "throw") throw new Error("Telemetry offline");
      return Promise.reject(new Error("Telemetry offline"));
    });
    const worker = createWorker({
      storage: s.storage,
      trace,
      profiles: {
        v1: {
          provider: createFakeProvider(() => ({
            content: "Done",
            toolCalls: [],
            finishReason: "stop",
          })),
          tools: [],
          system: "Help",
        },
      },
    });
    try {
      await worker.tick();
      expect(
        (await s.storage.jobs.load(s.identity, "chat", "one"))?.status,
      ).toBe("completed");
      expect(trace).toHaveBeenCalledOnce();
    } finally {
      await worker.stop();
    }
  },
);

it("does not execute inherited agent profiles", async () => {
  const s = await storageFixture("sqlite");
  await s.storage.jobs.submit(s.identity, "chat", {
    id: "one",
    profileId: "v1",
    input: "Hello",
  });
  const provider = createFakeProvider(() => ({
    content: "Done",
    toolCalls: [],
    finishReason: "stop",
  }));
  const profiles = {};
  Object.setPrototypeOf(profiles, {
    v1: { provider, tools: [], system: "Help" },
  });
  const worker = createWorker({ storage: s.storage, profiles });
  try {
    await worker.tick();
    expect(provider.requests).toHaveLength(0);
    expect((await s.storage.jobs.load(s.identity, "chat", "one"))?.status).toBe(
      "queued",
    );
  } finally {
    await worker.stop();
  }
});
