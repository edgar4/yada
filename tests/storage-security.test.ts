import { expect, it } from "vitest";
import { storageCipher } from "../src/storage/crypto.js";
import { oauthSessionSchema } from "../src/storage/oauth-schema.js";
import { createStorage } from "../src/index.js";
it("detects tampering and record relocation", () => {
  const cipher = storageCipher("ab".repeat(32));
  const value = cipher.seal("a", { secret: "value" });
  expect(() => cipher.open("b", value)).toThrow();
  expect(() => cipher.open("a", value.slice(0, -4) + "AAAA")).toThrow();
  expect(() => cipher.open("a", "invalid")).toThrow("Invalid storage envelope");
});
it("preserves OAuth discovery metadata and optional verifier fields", () => {
  const value = {
    client: {
      client_id: "id",
      issuer: "https://auth.example",
      custom: "retain",
    },
    tokens: {
      access_token: "secret",
      token_type: "Bearer",
      issuer: "https://auth.example",
      custom: "retain",
    },
    discovery: {
      authorizationServerUrl: "https://auth.example",
      authorizationServerMetadata: {
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        response_types_supported: ["code"],
        authorization_response_iss_parameter_supported: true,
      },
      resourceMetadata: { resource: "https://mcp.example" },
      resourceMetadataUrl:
        "https://mcp.example/.well-known/oauth-protected-resource",
    },
    pending: { state: "s", expiresAt: 1 },
  };
  expect(oauthSessionSchema.parse(value)).toEqual(value);
  expect(
    oauthSessionSchema.parse({
      discovery: { authorizationServerUrl: "https://auth.example" },
    }),
  ).toEqual({ discovery: { authorizationServerUrl: "https://auth.example" } });
});
it("fails database initialization without falling back to memory", async () => {
  await expect(
    createStorage({
      driver: "sqlite",
      filename: "/nonexistent-yada-directory/db.sqlite",
      encryptionKey: "ab".repeat(32),
    }),
  ).rejects.toThrow();
});
