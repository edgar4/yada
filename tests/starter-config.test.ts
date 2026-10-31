import { expect, it } from "vitest";
import { starterConfigFromEnv } from "../examples/starter/config.js";
import { starterTools } from "../examples/starter/tools.js";

const env = {
  YADA_STARTER_PASSWORD: "a-long-generated-starter-password",
  YADA_STORAGE_KEY: "ab".repeat(32),
  YADA_LLM_PROVIDER: "anthropic",
  YADA_LLM_API_KEY: "provider-secret",
};

it("accepts an omitted or empty password without a separate auth setting", () => {
  expect(
    starterConfigFromEnv({ ...env, YADA_STARTER_PASSWORD: undefined }).password,
  ).toBe("");
  expect(
    starterConfigFromEnv({ ...env, YADA_STARTER_PASSWORD: "" }).password,
  ).toBe("");
});

it("uses the shared provider and database settings with local defaults", () => {
  expect(starterConfigFromEnv({ ...env, PORT: "3001" }).origin).toBe(
    "http://localhost:3001",
  );
  expect(starterConfigFromEnv(env)).toMatchObject({
    origin: "http://localhost:3000",
    port: 3000,
    servers: [],
    provider: { provider: "anthropic", apiKey: "provider-secret" },
    storage: { driver: "sqlite", filename: "work/starter/yada.sqlite" },
  });
  for (const driver of ["postgres", "mysql"])
    expect(
      starterConfigFromEnv({
        ...env,
        YADA_STORAGE_DRIVER: driver,
        YADA_STORAGE_URL: `${driver}://localhost/yada`,
      }).storage.driver,
    ).toBe(driver);
  expect(
    starterConfigFromEnv({
      ...env,
      YADA_LLM_PROVIDER: "ollama",
      YADA_LLM_MODEL: "local-model",
      YADA_LLM_API_KEY: "",
    }).provider,
  ).toMatchObject({ provider: "ollama", model: "local-model" });
});

it.each([
  "http://example.com",
  "https://example.com/path",
  "https://user:password@example.com",
  "https://example.com/",
  "null",
])("rejects unsafe or ambiguous browser origin %s", (origin) => {
  expect(() =>
    starterConfigFromEnv({ ...env, YADA_STARTER_ORIGIN: origin }),
  ).toThrow("YADA_STARTER_ORIGIN");
});

it("requires secrets without echoing their values and reuses MCP validation", () => {
  expect(() =>
    starterConfigFromEnv({ ...env, YADA_STARTER_PASSWORD: "short" }),
  ).toThrow("24–256");
  expect(() =>
    starterConfigFromEnv({ ...env, YADA_STORAGE_KEY: "invalid-private-key" }),
  ).toThrow("storage configuration");
  expect(() => starterConfigFromEnv({ ...env, YADA_LLM_API_KEY: "" })).toThrow(
    "provider configuration",
  );
  expect(() =>
    starterConfigFromEnv({ ...env, YADA_MCP_SERVERS: "not-json" }),
  ).toThrow("YADA_MCP_SERVERS");
  expect(
    starterConfigFromEnv({
      ...env,
      YADA_MCP_SERVERS: '[{"name":"remote","url":"https://example.com/mcp"}]',
    }).servers,
  ).toHaveLength(1);
});

it("provides scoped, typed tools without access to configuration secrets", async () => {
  const owner = { actorId: "owner", tenantId: "starter" };
  const tools = starterTools(owner);
  for (const tool of tools) {
    expect(await tool.authorize(owner)).toBe(true);
    expect(await tool.authorize({ ...owner, actorId: "other" })).toBe(false);
    expect(await tool.authorize({ ...owner, tenantId: "other" })).toBe(false);
    await expect(
      tool.execute({ unexpected: true }, owner, AbortSignal.timeout(1000)),
    ).rejects.toThrow();
    const output = await tool.execute({}, owner, AbortSignal.timeout(1000));
    expect(output).not.toContain(env.YADA_LLM_API_KEY);
    expect(output).not.toContain(env.YADA_STORAGE_KEY);
    expect(output.length).toBeGreaterThan(10);
  }
});
