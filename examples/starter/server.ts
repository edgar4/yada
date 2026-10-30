import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeServer, createStorage } from "yada";
import { createStarterApp } from "./app.js";
import { starterConfigFromEnv } from "./config.js";

const config = starterConfigFromEnv(process.env);
if (config.storage.driver === "sqlite")
  await mkdir(dirname(config.storage.filename ?? "yada.sqlite"), {
    recursive: true,
    mode: 0o700,
  });
const storage = await createStorage(config.storage);
try {
  const publicRoot = pathToFileURL(resolve("work/starter/public") + "/");
  const app = await createStarterApp({
    config,
    storage,
    assets: {
      "/": await readFile(new URL("index.html", publicRoot), "utf8"),
      "/assets/client.js": await readFile(
        new URL("client.js", publicRoot),
        "utf8",
      ),
      "/assets/style.css": await readFile(
        new URL("style.css", publicRoot),
        "utf8",
      ),
    },
  });
  const server = createNodeServer((request) => app.handle(request));
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
      server.closeAllConnections();
      const results = await Promise.allSettled([closed, app.close()]);
      await storage.close();
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Starter shutdown failed");
    })());
  try {
    server.listen(config.port, "127.0.0.1");
    await once(server, "listening");
    app.worker.start();
    console.log(`Yada starter: ${config.origin}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void stop().catch(() => {
          process.exitCode = 1;
        });
      });
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
} catch (error) {
  await storage.close();
  throw error;
}
