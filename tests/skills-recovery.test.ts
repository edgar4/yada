import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSkills,
  createFakeProvider,
  runDurable,
  CheckpointError,
} from "../src/index.js";
import { drivers, storageFixture } from "./helpers/storage.js";
import { createStarterApp } from "../examples/starter/app.js";
import { starterConfigFromEnv } from "../examples/starter/config.js";
import { starterIdentity } from "../examples/starter/auth.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function skillFixture() {
  const root = await mkdtemp(join(tmpdir(), "yada-skill-recovery-"));
  roots.push(root);
  const directory = join(root, "support");
  await mkdir(directory);
  const source =
    "---\nname: support\ndescription: Answer support questions\n---\nAsk for an order number.";
  const file = join(directory, "SKILL.md");
  await writeFile(file, source);
  return {
    root,
    file,
    source,
    load: () =>
      loadSkills({
        directories: [root],
        authorize: () => Promise.resolve(true),
      }),
  };
}
for (const driver of drivers)
  describe(`${driver} skill persistence`, () => {
    it("recovers a pending skill read and rejects changed skill snapshots", async () => {
      const fixture = await storageFixture(driver);
      const skill = await skillFixture();
      const catalog = await skill.load();
      const provider = createFakeProvider((request) => {
        const last = request.messages.at(-1);
        if (last?.role === "tool") {
          expect(last.content).toContain("Ask for an order number");
          return {
            content: "Your order number?",
            toolCalls: [],
            finishReason: "stop",
          };
        }
        return {
          content: "",
          toolCalls: [
            {
              id: "skill-read",
              name: "yada_read_skill",
              args: { name: "support" },
            },
          ],
          finishReason: "tool_calls",
        };
      });
      const options = {
        ...catalog,
        provider,
        identity: fixture.identity,
        input: "Help with an order",
        runId: "skill-run",
        profileId: "support",
        signal: AbortSignal.timeout(10_000),
      };
      await expect(
        runDurable({
          ...options,
          store: {
            ...fixture.storage.runs,
            save: async (...args) => {
              if (args[3].messages.some((turn) => turn.role === "tool"))
                throw new Error("Interrupted save");
              await fixture.storage.runs.save(...args);
            },
          },
        }),
      ).rejects.toBeInstanceOf(CheckpointError);
      const saved = await fixture.storage.runs.load(
        fixture.identity,
        "skill-run",
      );
      expect(saved?.checkpoint?.pending).toHaveLength(1);
      if (!saved?.lease) throw new Error("Missing run lease");
      await fixture.storage.runs.release(
        fixture.identity,
        "skill-run",
        saved.lease.token,
      );
      await fixture.reopen();
      await writeFile(skill.file, skill.source + " Changed instructions.");
      const changed = await skill.load();
      await expect(
        runDurable({ ...options, ...changed, store: fixture.storage.runs }),
      ).rejects.toThrow("configuration mismatch");
      expect(provider.requests).toHaveLength(1);
      await writeFile(skill.file, skill.source);
      const restored = await skill.load();
      await expect(
        runDurable({ ...options, ...restored, store: fixture.storage.runs }),
      ).resolves.toEqual({ status: "completed", text: "Your order number?" });
      expect(provider.requests).toHaveLength(2);
      await expect(
        fixture.storage.runs.load(
          { ...fixture.identity, tenantId: "other" },
          "skill-run",
        ),
      ).resolves.toBeUndefined();
    });

    it("loads a project skill through the starter service and persists the answer", async () => {
      const fixture = await storageFixture(driver);
      const skill = await skillFixture();
      const provider = createFakeProvider((request) => {
        expect(request.system).toContain("Answer support questions");
        return request.messages.some((turn) => turn.role === "tool")
          ? {
              content: "Your order number?",
              toolCalls: [],
              finishReason: "stop",
            }
          : {
              content: "",
              toolCalls: [
                {
                  id: "read",
                  name: "yada_read_skill",
                  args: { name: "support" },
                },
              ],
              finishReason: "tool_calls",
            };
      });
      const config = starterConfigFromEnv({
        YADA_STORAGE_KEY: "ab".repeat(32),
        YADA_LLM_PROVIDER: "gemini",
        YADA_LLM_API_KEY: "test",
        YADA_SKILLS_DIR: skill.root,
      });
      const app = await createStarterApp({
        config: { ...config, storage: fixture.config },
        storage: fixture.storage,
        provider,
        assets: {
          "/": "Yada",
          "/assets/client.js": "",
          "/assets/style.css": "",
        },
      });
      try {
        const response = await app.handle(
          new Request("http://localhost:3000/v1/conversations/skills/runs", {
            method: "POST",
            headers: {
              origin: "http://localhost:3000",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              id: "first",
              profileId: "starter",
              input: "Help with an order",
            }),
          }),
        );
        expect(response.status).toBe(202);
        await app.worker.tick();
        expect(
          (await fixture.storage.jobs.load(starterIdentity, "skills", "first"))
            ?.status,
        ).toBe("completed");
        expect(
          (
            await fixture.storage.conversations.load(starterIdentity, "skills")
          )?.messages.at(-1)?.content,
        ).toBe("Your order number?");
      } finally {
        await app.close();
      }
    });
  });
