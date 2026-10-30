import process from "node:process";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    fileParallelism:
      !process.env.YADA_TEST_POSTGRES_URL && !process.env.YADA_TEST_MYSQL_URL,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 85 },
    },
  },
});
