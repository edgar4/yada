import { expect, it } from "vitest";
import { mcpServersFromEnv } from "../src/index.js";
it("disables MCP when unconfigured", () => {
  expect(mcpServersFromEnv({})).toEqual([]);
  expect(mcpServersFromEnv({ YADA_MCP_SERVERS: " " })).toEqual([]);
});
it("loads servers with automatic discovery", () => {
  expect(
    mcpServersFromEnv({
      YADA_MCP_SERVERS: '[{"name":"catalog","url":"https://example.test/mcp"}]',
    }),
  ).toEqual([{ name: "catalog", url: "https://example.test/mcp" }]);
});
it.each([
  "invalid",
  "{}",
  '[{"name":"a","url":"file:///tmp/secret"}]',
  '[{"name":"a","url":"https://example.test"},{"name":"a","command":"node"}]',
])("rejects invalid server settings without exposing them", (raw) => {
  expect(() => mcpServersFromEnv({ YADA_MCP_SERVERS: raw })).toThrow(
    "Invalid YADA_MCP_SERVERS configuration",
  );
});
