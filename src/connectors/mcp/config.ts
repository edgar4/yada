import { z } from "zod";
const common = {
  name: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
  readTools: z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .refine((tools) => new Set(tools).size === tools.length)
    .optional(),
  writeTools: z
    .record(
      z.string().min(1),
      z.strictObject({
        version: z.string().min(1).max(128),
        prepareTool: z.string().min(1),
        receiptTool: z.string().min(1),
      }),
    )
    .refine(
      (tools) =>
        Object.keys(tools).length > 0 && Object.keys(tools).length <= 1000,
    )
    .optional(),
};
export const mcpConfig = z
  .union([
    z.strictObject({
      ...common,
      url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.hash
        );
      }),
      token: z.string().min(1).optional(),
    }),
    z.strictObject({
      ...common,
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
    }),
  ])
  .superRefine((settings, context) => {
    const reads = new Set(settings.readTools);
    const writes = new Set(Object.keys(settings.writeTools ?? {}));
    const helpers = new Set<string>();
    for (const [name, mapping] of Object.entries(settings.writeTools ?? {})) {
      if (reads.has(name))
        context.addIssue({
          code: "custom",
          message: "Overlapping MCP tool roles",
        });
      for (const helper of [mapping.prepareTool, mapping.receiptTool]) {
        if (reads.has(helper) || writes.has(helper) || helpers.has(helper))
          context.addIssue({
            code: "custom",
            message: "Overlapping MCP helper roles",
          });
        helpers.add(helper);
      }
    }
  });
export type McpConfig = z.input<typeof mcpConfig>;
export type McpReadConfig = McpConfig & { writeTools?: undefined };
export type McpWriteMapping = NonNullable<McpConfig["writeTools"]>[string];
export function mcpServersFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): McpConfig[] {
  const raw = env["YADA_MCP_SERVERS"];
  if (raw === undefined || raw.trim() === "") return [];
  try {
    const servers = z.array(mcpConfig).parse(JSON.parse(raw));
    if (new Set(servers.map((server) => server.name)).size !== servers.length)
      throw new Error("Duplicate MCP server names");
    return servers;
  } catch {
    throw new Error("Invalid YADA_MCP_SERVERS configuration");
  }
}
