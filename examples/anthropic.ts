import { z } from "zod";
import { createAnthropicProvider, readTool, run } from "../src/index.js";
const config = z
  .object({
    YADA_ANTHROPIC_API_KEY: z.string().min(1),
    YADA_ANTHROPIC_MODEL: z.string().min(1),
  })
  .parse(process.env);
const provider = createAnthropicProvider({
  apiKey: config.YADA_ANTHROPIC_API_KEY,
  model: config.YADA_ANTHROPIC_MODEL,
});
const tool = readTool({
  name: "catalog_lookup",
  description: "Look up product availability by ID.",
  input: z.strictObject({ id: z.string() }),
  authorize: () => Promise.resolve(true),
  execute: ({ id }) =>
    Promise.resolve(JSON.stringify({ id, available: id === "demo" })),
});
const result = await run({
  provider,
  tools: [tool],
  identity: { actorId: "local-demo", tenantId: "local-demo" },
  input: "Is product demo available? Check the catalog.",
  system:
    "Use the catalog to answer availability questions. Ask for missing information rather than guessing.",
  signal: AbortSignal.timeout(30_000),
});
console.log(result);
if (result.status !== "completed") process.exitCode = 1;
