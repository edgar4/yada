import { timingSafeEqual } from "node:crypto";
import {
  createFakeProvider,
  createHandler,
  createNodeServer,
  createStorage,
  createWorker,
  storageConfigFromEnv,
} from "yada";

const token = process.env.YADA_DEMO_TOKEN;
if (!token || token.length < 32)
  throw new Error("YADA_DEMO_TOKEN must contain at least 32 characters");
const origin = process.env.YADA_DEMO_ORIGIN ?? "http://localhost:3000";
const expected = Buffer.from(`Bearer ${token}`);
const storage = await createStorage(storageConfigFromEnv(process.env));
const worker = createWorker({
  storage,
  profiles: {
    demo: {
      provider: createFakeProvider(() => ({
        content:
          "Yada is running. Replace the demo profile with your server-side tools and provider.",
        toolCalls: [],
        finishReason: "stop",
      })),
      tools: [],
      system: "Help the user.",
    },
  },
});
const handler = createHandler({
  storage,
  origins: [origin],
  authenticate: async (request) => {
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    return actual.length === expected.length &&
      timingSafeEqual(actual, expected)
      ? { actorId: "demo", tenantId: "demo" }
      : undefined;
  },
  authorizeProfile: async (_, profileId) => profileId === "demo",
});
const server = createNodeServer(handler);
worker.start();
server.listen(3000, "0.0.0.0");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await worker.stop();
  await storage.close();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void stop().catch(() => process.exit(1)));
