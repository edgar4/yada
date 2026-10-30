import { z } from "zod";
const common = {
  name: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
  readTools: z.array(z.string().min(1)).min(1).optional(),
};
export const mcpConfig = z.union([
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
]);
export type McpConfig = z.input<typeof mcpConfig>;
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
