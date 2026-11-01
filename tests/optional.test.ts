import { describe, expect, it } from "vitest";
import { knexClient, optionalImport } from "../src/optional.js";
const missing: string = "yada-not-installed";
describe("optional packages", () => {
  it("names the package to install when an import is missing", async () => {
    await expect(
      optionalImport(() => import(missing), "yada-not-installed", "The thing"),
    ).rejects.toThrow("The thing requires yada-not-installed");
  });
  it("rethrows other import failures", async () => {
    await expect(
      optionalImport(() => Promise.reject(new Error("boom")), "x", "y"),
    ).rejects.toThrow("boom");
  });
  it("resolves installed storage drivers", () => {
    expect(knexClient("sqlite")).toBe("better-sqlite3");
  });
});
