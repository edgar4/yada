import { expect, it, vi } from "vitest";
import {
  connectMcp,
  createFakeProvider,
  type McpConnection,
  type Tool,
} from "@edgaralochi/yada";
import { createStarterApp } from "../examples/starter/app.js";
import { starterConfigFromEnv } from "../examples/starter/config.js";
import { storageFixture } from "./helpers/storage.js";

vi.mock("@edgaralochi/yada", async (original) => ({
  ...(await original<typeof import("@edgaralochi/yada")>()),
  connectMcp: vi.fn(),
}));

async function setup() {
  const fixture = await storageFixture("sqlite");
  const config = starterConfigFromEnv({
    YADA_STARTER_PASSWORD: "a-long-generated-starter-password",
    YADA_STORAGE_KEY: "ab".repeat(32),
    YADA_LLM_PROVIDER: "anthropic",
    YADA_LLM_API_KEY: "secret",
  });
  return {
    config: {
      ...config,
      storage: fixture.config,
      servers: [
        { name: "first", url: "https://first.test/mcp" },
        { name: "second", url: "https://second.test/mcp" },
      ],
    },
    storage: fixture.storage,
    provider: createFakeProvider(() => ({
      content: "Done",
      toolCalls: [],
      finishReason: "stop",
    })),
    assets: { "/": "Yada", "/assets/client.js": "", "/assets/style.css": "" },
  };
}

it("closes earlier MCP connections when a later connection fails during startup", async () => {
  const close = vi.fn(() => Promise.resolve());
  const connection: McpConnection<Tool> = { tools: [], close };
  vi.mocked(connectMcp)
    .mockResolvedValueOnce(connection)
    .mockRejectedValueOnce(new Error("offline"));
  await expect(createStarterApp(await setup())).rejects.toThrow("offline");
  expect(close).toHaveBeenCalledOnce();
});

it("closes every MCP connection even when worker shutdown or another close fails", async () => {
  const first = vi.fn(() => Promise.reject(new Error("close failed")));
  const second = vi.fn(() => Promise.resolve());
  vi.mocked(connectMcp)
    .mockResolvedValueOnce({ tools: [], close: first })
    .mockResolvedValueOnce({ tools: [], close: second });
  const app = await createStarterApp(await setup());
  vi.spyOn(app.worker, "stop").mockRejectedValueOnce(
    new Error("storage offline"),
  );
  await expect(app.close()).rejects.toThrow("shutdown failed");
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
});
