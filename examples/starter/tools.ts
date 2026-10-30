import { z } from "zod";
import { readTool, type Identity } from "@edgaralochi/yada";

export function starterTools(owner: Identity) {
  const authorize = (identity: Identity) =>
    Promise.resolve(
      identity.actorId === owner.actorId &&
        identity.tenantId === owner.tenantId,
    );
  return [
    readTool({
      name: "current_time",
      description: "Read the current UTC date and time.",
      input: z.strictObject({}),
      authorize,
      execute: () => Promise.resolve(new Date().toISOString()),
    }),
    readTool({
      name: "starter_guide",
      description: "Read how this Yada starter is configured and extended.",
      input: z.strictObject({}),
      authorize,
      execute: () =>
        Promise.resolve(
          "This is a single-workspace Yada starter. Select your model with YADA_LLM_PROVIDER, YADA_LLM_MODEL and YADA_LLM_API_KEY on the server. SQLite is the default; PostgreSQL and MySQL are supported. Add typed tools in tools.ts or reviewed MCP servers through YADA_MCP_SERVERS. The host owns permissions. Provider keys and storage keys are never browser configuration.",
        ),
    }),
  ];
}
