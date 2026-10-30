import { z } from "zod";
import { it, expect } from "vitest";
import { once } from "node:events";
import { createNodeServer } from "@edgaralochi/yada";
import { createStarterApp } from "../examples/starter/app.js";
import { starterConfigFromEnv } from "../examples/starter/config.js";
import { starterIdentity } from "../examples/starter/auth.js";
import { storageFixture } from "./helpers/storage.js";

it("uses the configured real provider adapter and executes its tool call", async () => {
  const requests: unknown[] = [];
  const authorization: (string | null)[] = [];
  const providerServer = createNodeServer(async (request) => {
    expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
    requests.push(await request.json());
    authorization.push(request.headers.get("authorization"));
    const first = requests.length === 1;
    return Response.json({
      id: `completion-${String(requests.length)}`,
      object: "chat.completion",
      created: 1,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: first ? "" : "The time tool ran.",
            ...(first
              ? {
                  tool_calls: [
                    {
                      id: "time-call",
                      type: "function",
                      function: { name: "current_time", arguments: "{}" },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: first ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  });
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const address = providerServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing provider address");
  try {
    const fixture = await storageFixture("sqlite");
    const config = starterConfigFromEnv({
      YADA_STARTER_PASSWORD: "generated-starter-password-123",
      YADA_STORAGE_KEY: "ab".repeat(32),
      YADA_LLM_PROVIDER: "ollama",
      YADA_LLM_MODEL: "fixture-model",
      YADA_LLM_API_KEY: "server-only-provider-secret",
      YADA_LLM_BASE_URL: `http://127.0.0.1:${String(address.port)}/v1`,
    });
    const app = await createStarterApp({
      config: { ...config, storage: fixture.config },
      storage: fixture.storage,
      assets: { "/": "Yada", "/assets/client.js": "", "/assets/style.css": "" },
    });
    try {
      await fixture.storage.jobs.submit(starterIdentity, "chat", {
        id: "live-adapter",
        profileId: "starter",
        input: "What is the current time?",
      });
      await app.worker.tick();
      expect(
        (
          await fixture.storage.jobs.load(
            starterIdentity,
            "chat",
            "live-adapter",
          )
        )?.status,
      ).toBe("completed");
      expect(requests).toHaveLength(2);
      expect(authorization).toEqual([
        "Bearer server-only-provider-secret",
        "Bearer server-only-provider-secret",
      ]);
      expect(requests[0]).toHaveProperty("model", "fixture-model");
      expect(requests[0]).toHaveProperty(
        "tools.0.function.name",
        "current_time",
      );
      const payload = z
        .object({
          messages: z.array(
            z.object({
              role: z.string(),
              content: z.unknown(),
              tool_call_id: z.string().optional(),
            }),
          ),
        })
        .parse(requests[1]);
      const toolResult = payload.messages.find(
        (message) => message.role === "tool",
      );
      expect(toolResult?.tool_call_id).toBe("time-call");
      expect(toolResult?.content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(
        (
          await fixture.storage.conversations.load(starterIdentity, "chat")
        )?.messages.at(-1)?.content,
      ).toBe("The time tool ran.");
    } finally {
      await app.close();
    }
  } finally {
    providerServer.closeAllConnections();
    await new Promise<void>((resolve) =>
      providerServer.close(() => {
        resolve();
      }),
    );
  }
});
