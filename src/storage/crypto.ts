import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export function storageCipher(keyHex: string) {
  const key = Buffer.from(keyHex, "hex");
  return {
    seal(id: string, value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(id));
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        encrypted.toString("base64"),
      ].join(".");
    },
    open(id: string, value: string): unknown {
      const [version, iv, tag, data, ...extra] = value.split(".");
      if (version !== "v1" || !iv || !tag || data === undefined || extra.length)
        throw new Error("Invalid storage envelope");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64"),
      );
      cipher.setAAD(Buffer.from(id));
      cipher.setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          cipher.update(Buffer.from(data, "base64")),
          cipher.final(),
        ]).toString("utf8"),
      ) as unknown;
    },
  };
}
