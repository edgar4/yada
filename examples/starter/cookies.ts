import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const lifetime = 8 * 60 * 60 * 1000;
const cookieName = "yada_starter_session";
export function createStarterCookies(material: Uint8Array, secure: boolean) {
  const secret = Buffer.from(material);
  const signingKey = () =>
    Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        randomBytes(32),
        "yada/starter/session/v1",
        32,
      ),
    );
  let key = signingKey();
  const revoked = new Map<string, number>();
  const signature = (payload: string) =>
    createHmac("sha256", key).update(payload).digest();
  const cookie = (value: string, age: number) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(age)}${secure ? "; Secure" : ""}`;
  function read(request: Request) {
    for (const [nonce, expiry] of revoked)
      if (expiry <= Date.now()) revoked.delete(nonce);
    const cookies = request.headers.get("cookie") ?? "";
    if (cookies.length > 8192) return undefined;
    const values = cookies
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return undefined;
    const token = values[0]?.slice(cookieName.length + 1);
    const match =
      /^([a-zA-Z0-9_-]{32})\.([1-9][0-9]{0,15})\.([a-zA-Z0-9_-]{43})$/.exec(
        token ?? "",
      );
    if (!match?.[1] || !match[2] || !match[3]) return undefined;
    const expiry = Number(match[2]);
    if (!Number.isSafeInteger(expiry) || expiry <= Date.now()) return undefined;
    const actual = Buffer.from(match[3], "base64url");
    if (
      actual.toString("base64url") !== match[3] ||
      !timingSafeEqual(actual, signature(`${match[1]}.${match[2]}`)) ||
      revoked.has(match[1])
    )
      return undefined;
    return { nonce: match[1], expiry };
  }
  return {
    has: (request: Request) => read(request) !== undefined,
    issue() {
      const payload = `${randomBytes(24).toString("base64url")}.${String(Date.now() + lifetime)}`;
      return cookie(
        `${payload}.${signature(payload).toString("base64url")}`,
        lifetime / 1000,
      );
    },
    logout(request: Request) {
      const current = read(request);
      if (current) {
        if (revoked.size >= 128) {
          key = signingKey();
          revoked.clear();
        } else revoked.set(current.nonce, current.expiry);
      }
      return cookie("", 0);
    },
  };
}
