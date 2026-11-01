import { z } from "zod";
const common = {
  name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
  readTools: z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .refine((tools) => new Set(tools).size === tools.length)
    .optional(),
  confirmTools: z
    .union([
      z.literal("*"),
      z
        .array(z.string().min(1))
        .min(1)
        .max(1000)
        .refine((tools) => new Set(tools).size === tools.length),
    ])
    .optional(),
  resources: z.boolean().optional(),
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
      headers: z.record(z.string(), z.string()).optional(),
    }),
    z.strictObject({
      ...common,
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().min(1).optional(),
      stderr: z.enum(["ignore", "inherit"]).default("ignore"),
    }),
  ])
  .superRefine((settings, context) => {
    if (
      "headers" in settings &&
      settings.token &&
      Object.keys(settings.headers ?? {}).some(
        (name) => name.toLowerCase() === "authorization",
      )
    )
      context.addIssue({
        code: "custom",
        message: "Authorization header conflicts with token",
      });
    const reads = new Set(settings.readTools);
    const writes = new Set(Object.keys(settings.writeTools ?? {}));
    const helpers = new Set<string>();
    const confirms = Array.isArray(settings.confirmTools)
      ? settings.confirmTools
      : [];
    if (confirms.some((name) => reads.has(name)))
      context.addIssue({
        code: "custom",
        message: "Overlapping MCP tool roles",
      });
    for (const [name, mapping] of Object.entries(settings.writeTools ?? {})) {
      if (reads.has(name) || confirms.includes(name))
        context.addIssue({
          code: "custom",
          message: "Overlapping MCP tool roles",
        });
      for (const helper of [mapping.prepareTool, mapping.receiptTool]) {
        if (
          reads.has(helper) ||
          writes.has(helper) ||
          helpers.has(helper) ||
          confirms.includes(helper)
        )
          context.addIssue({
            code: "custom",
            message: "Overlapping MCP helper roles",
          });
        helpers.add(helper);
      }
    }
  });
export type McpConfig = z.input<typeof mcpConfig>;
export type McpReadConfig = McpConfig & {
  writeTools?: undefined;
  confirmTools?: undefined;
};
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
