import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
const keyOf = (hex: string) => ({
  id: createHash("sha256").update(hex.toLowerCase()).digest("hex").slice(0, 8),
  key: Buffer.from(hex, "hex"),
});
export function storageCipher(
  keyHex: string,
  previousKeys: readonly string[] = [],
) {
  const current = keyOf(keyHex);
  const readable = [current, ...previousKeys.map(keyOf)];
  return {
    seal(id: string, value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", current.key, iv);
      cipher.setAAD(Buffer.from(id));
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return [
        "v2",
        current.id,
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        encrypted.toString("base64"),
      ].join(".");
    },
    isCurrent: (value: string) => value.startsWith(`v2.${current.id}.`),
    open(id: string, value: string): unknown {
      const [version, ...fields] = value.split(".");
      const [keyId, iv, tag, data, ...extra] =
        version === "v2" ? fields : [undefined, ...fields];
      if (
        (version !== "v1" && version !== "v2") ||
        !iv ||
        !tag ||
        data === undefined ||
        extra.length
      )
        throw new Error("Invalid storage envelope");
      let failure: unknown = new Error("Unknown storage key");
      for (const { id: candidate, key } of readable) {
        if (keyId !== undefined && keyId !== candidate) continue;
        try {
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
        } catch (error) {
          failure = error;
        }
      }
      throw failure;
    },
  };
}
