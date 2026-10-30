import { expect, it } from "vitest";
import { abortable } from "../src/core/abort.js";
it("cancels an uncooperative dependency", async () => {
  const controller = new AbortController();
  const pending = abortable(
    () => new Promise<never>(() => {}),
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
});
it("rejects an already cancelled operation", async () => {
  await expect(
    abortable(() => Promise.resolve(1), AbortSignal.abort()),
  ).rejects.toThrow();
});
it("captures synchronous throws", async () => {
  await expect(
    abortable(() => {
      throw new Error("failure");
    }, new AbortController().signal),
  ).rejects.toThrow("failure");
});
