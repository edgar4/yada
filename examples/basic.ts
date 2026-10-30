import { z } from "zod";
import { createFakeProvider, readTool, run } from "../src/index.js";
const tool = readTool({
  name: "catalog_lookup",
  description: "Look up a product",
  input: z.strictObject({ id: z.string() }),
  authorize: () => Promise.resolve(true),
  execute: ({ id }) => Promise.resolve(`Product ${id}: available`),
});
const provider = createFakeProvider((request, call) =>
  call === 1
    ? {
        content: "",
        toolCalls: [{ id: "1", name: "catalog_lookup", args: { id: "demo" } }],
        finishReason: "tool_calls",
      }
    : {
        content: request.messages.at(-1)?.content ?? "",
        toolCalls: [],
        finishReason: "stop",
      },
);
console.log(
  await run({
    provider,
    tools: [tool],
    identity: { actorId: "demo", tenantId: "demo" },
    input: "Is demo available?",
    system: "Help with the catalog.",
    signal: AbortSignal.timeout(5000),
  }),
);
