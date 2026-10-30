import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@edgaralochi\/yada$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      {
        find: /^@edgaralochi\/yada\/client$/,
        replacement: fileURLToPath(
          new URL("./src/client/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@edgaralochi\/yada\/widget$/,
        replacement: fileURLToPath(
          new URL("./src/widget/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism:
      !process.env.YADA_TEST_POSTGRES_URL && !process.env.YADA_TEST_MYSQL_URL,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "examples/starter/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/widget/**",
        "examples/starter/client.ts",
        "examples/starter/server.ts",
      ],
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 85 },
    },
  },
});
