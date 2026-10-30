import { afterEach, expect, it } from "vitest";
import {
  protocolServer,
  mutation,
  writeConfig,
} from "./helpers/mcp-protocol.js";
import { mcpWriteTools } from "./helpers/mcp-write-server.js";
import type { McpConfig } from "../src/index.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function version(config: McpConfig = writeConfig, tools = mcpWriteTools) {
  const server = protocolServer({ tools });
  cleanups.push(() => server.close());
  return mutation(await server.connect(config)).version;
}
it("binds reviewed versions to endpoints and stdio command/arguments, excluding rotating bearer tokens", async () => {
  const baseline = await version();
  expect(await version({ ...writeConfig, token: "rotated" })).toBe(baseline);
  expect(
    await version({ ...writeConfig, url: "https://other.test/mcp" }),
  ).not.toBe(baseline);
  expect(
    await version({
      ...writeConfig,
      writeTools: {
        change: { ...writeConfig.writeTools.change, version: "v2" },
      },
    }),
  ).not.toBe(baseline);
  const local = {
    name: "remote",
    command: "node",
    args: ["server.js"],
    writeTools: writeConfig.writeTools,
  };
  const localVersion = await version(local);
  expect(await version({ ...local, command: "other" })).not.toBe(localVersion);
  expect(await version({ ...local, args: ["different.js"] })).not.toBe(
    localVersion,
  );
});
it.each(["change", "preview", "receipt"])(
  "pins %s input and output schemas",
  async (name) => {
    const baseline = await version();
    const input = structuredClone(mcpWriteTools);
    const target = input.find((tool) => tool.name === name);
    if (!target) throw new Error("Missing fixture tool");
    target.inputSchema["maxProperties"] = 100;
    expect(await version(writeConfig, input)).not.toBe(baseline);
    const output = structuredClone(mcpWriteTools);
    const other = output.find((tool) => tool.name === name);
    if (!other?.outputSchema) throw new Error("Missing fixture output");
    other.outputSchema["maxProperties"] = 100;
    expect(await version(writeConfig, output)).not.toBe(baseline);
  },
);
it("pins helper mappings but ignores schema object property ordering", async () => {
  const baseline = await version();
  const tools = structuredClone(mcpWriteTools);
  const helper = tools.find((tool) => tool.name === "preview");
  if (!helper) throw new Error("Missing helper");
  helper.name = "different_preview";
  expect(
    await version(
      {
        ...writeConfig,
        writeTools: {
          change: {
            ...writeConfig.writeTools.change,
            prepareTool: helper.name,
          },
        },
      },
      tools,
    ),
  ).not.toBe(baseline);
  const reordered = structuredClone(mcpWriteTools);
  for (const tool of reordered)
    tool.inputSchema = Object.fromEntries(
      Object.entries(tool.inputSchema).reverse(),
    ) as typeof tool.inputSchema;
  expect(await version(writeConfig, reordered)).toBe(baseline);
});
