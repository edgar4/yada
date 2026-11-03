import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const missing = (packages: string, purpose: string, cause: unknown) =>
  new Error(
    `${purpose} requires ${packages}. Install it with: npm install ${packages}`,
    { cause },
  );
export async function optionalImport<T>(
  load: () => Promise<T>,
  packages: string,
  purpose: string,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND"
    )
      throw missing(packages, purpose, error);
    throw error;
  }
}
const drivers = {
  sqlite: "better-sqlite3",
  postgres: "pg",
  mysql: "mysql2",
} as const;
export function requirePackage(packages: string, purpose: string) {
  try {
    require.resolve(packages);
  } catch (error) {
    throw missing(packages, purpose, error);
  }
  return packages;
}
export const knexClient = (driver: keyof typeof drivers) =>
  requirePackage(drivers[driver], `The ${driver} storage driver`);
