import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
export const webhookSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  secret: z.string().min(16),
});
export type WebhookOptions = z.input<typeof webhookSchema>;
export function webhookSender(options: WebhookOptions) {
  const { url, secret } = webhookSchema.parse(options);
  return (payload: Readonly<Record<string, string>>) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const settled = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-yada-signature": signature,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        }).then(
          (response) => response.status < 500 && response.status !== 429,
          () => false,
        );
        if (settled) return;
        await delay(500 * 2 ** attempt);
      }
    })();
  };
}
