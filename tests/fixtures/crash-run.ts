import { z } from "zod";
import {
  createStorage,
  createFakeProvider,
  readTool,
  runDurable,
} from "../../src/index.js";
import { storageConfig } from "../../src/storage/config.js";
const config = storageConfig.parse(
  JSON.parse(process.env["YADA_CRASH_CONFIG"] ?? "{}"),
);
const store = await createStorage(config);
const tool = readTool({
  name: "lookup",
  description: "Lookup",
  input: z.strictObject({ id: z.string() }),
  authorize: () => Promise.resolve(true),
  execute: () => Promise.resolve("persisted result"),
});
const provider = createFakeProvider((_request, call) => {
  if (call === 1)
    return {
      content: "",
      toolCalls: [{ id: "call", name: "lookup", args: { id: "a" } }],
      finishReason: "tool_calls",
    };
  process.stdout.write("READY\n");
  return new Promise<never>(() => {});
});
await runDurable({
  runId: process.env["YADA_CRASH_ID"] ?? "",
  profileId: "test-v1",
  store: store.runs,
  leaseMs: 300,
  identity: { actorId: "actor", tenantId: "tenant" },
  provider,
  tools: [tool],
  input: "Find a",
  system: "Help",
  signal: new AbortController().signal,
});
