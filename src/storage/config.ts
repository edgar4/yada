import { z } from "zod";
const keyHex = z.string().regex(/^[a-fA-F0-9]{64}$/);
const secret = {
  encryptionKey: keyHex,
  previousEncryptionKeys: z.array(keyHex).default([]),
};
export const storageConfig = z.discriminatedUnion("driver", [
  z.strictObject({
    driver: z.literal("sqlite"),
    filename: z.string().min(1).default("yada.sqlite"),
    ...secret,
  }),
  z.strictObject({
    driver: z.literal("postgres"),
    url: z
      .url()
      .refine((v) =>
        ["postgres:", "postgresql:"].includes(new URL(v).protocol),
      ),
    ...secret,
  }),
  z.strictObject({
    driver: z.literal("mysql"),
    url: z.url().refine((v) => new URL(v).protocol === "mysql:"),
    ...secret,
  }),
]);
export type StorageConfig = z.input<typeof storageConfig>;
export function storageConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): StorageConfig {
  const driver = env["YADA_STORAGE_DRIVER"] ?? "sqlite";
  const result = storageConfig.safeParse({
    driver,
    encryptionKey: env["YADA_STORAGE_KEY"],
    ...(env["YADA_STORAGE_PREVIOUS_KEYS"]
      ? {
          previousEncryptionKeys: env["YADA_STORAGE_PREVIOUS_KEYS"]
            .split(",")
            .map((key) => key.trim()),
        }
      : {}),
    ...(driver === "sqlite"
      ? { filename: env["YADA_STORAGE_FILE"] }
      : { url: env["YADA_STORAGE_URL"] }),
  });
  if (!result.success)
    throw new Error(
      "Invalid storage configuration: check YADA_STORAGE_DRIVER, YADA_STORAGE_KEY, and database settings",
    );
  return result.data;
}
