import { z } from "zod";
import {
  mcpServersFromEnv,
  providerConfigFromEnv,
  storageConfigFromEnv,
} from "@edgaralochi/yada";

const settings = z.object({
  password: z.string().min(24).max(256),
  origin: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      value === url.origin &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }),
  port: z.coerce.number().int().min(1).max(65535),
});

export function starterConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
) {
  const result = settings.safeParse({
    password: env["YADA_STARTER_PASSWORD"],
    origin: env["YADA_STARTER_ORIGIN"] ?? "http://localhost:3000",
    port: env["PORT"] ?? "3000",
  });
  if (!result.success)
    throw new Error(
      "Check YADA_STARTER_PASSWORD (24–256 characters), YADA_STARTER_ORIGIN, and PORT",
    );
  return {
    ...result.data,
    provider: providerConfigFromEnv(env),
    storage: storageConfigFromEnv({
      ...env,
      YADA_STORAGE_FILE: env["YADA_STORAGE_FILE"] ?? "work/starter/yada.sqlite",
    }),
    servers: mcpServersFromEnv(env),
  };
}

export type StarterConfig = ReturnType<typeof starterConfigFromEnv>;
