import knex from "knex";
import { z } from "zod";
import { readTool } from "../core/tool.js";
import { abortable } from "../core/abort.js";
import type { Identity } from "../core/contracts.js";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const configuration = z.discriminatedUnion("driver", [
  z.strictObject({ driver: z.literal("sqlite"), filename: z.string().min(1) }),
  z.strictObject({
    driver: z.literal("postgres"),
    url: z
      .url()
      .refine((value) =>
        ["postgres:", "postgresql:"].includes(new URL(value).protocol),
      ),
  }),
  z.strictObject({
    driver: z.literal("mysql"),
    url: z.url().refine((value) => new URL(value).protocol === "mysql:"),
  }),
]);
export type ReadDatabaseConfig = z.infer<typeof configuration>;

export function createReadDatabase(config: ReadDatabaseConfig) {
  const settings = configuration.parse(config);
  const db = knex({
    client:
      settings.driver === "sqlite"
        ? "better-sqlite3"
        : settings.driver === "postgres"
          ? "pg"
          : "mysql2",
    connection:
      settings.driver === "sqlite"
        ? { filename: settings.filename }
        : settings.url,
    useNullAsDefault: true,
    pool: { min: 0, max: settings.driver === "sqlite" ? 1 : 5 },
  });
  let closed = false;
  return {
    async close() {
      closed = true;
      await db.destroy();
    },
    tool<S extends z.ZodType>(options: {
      name: string;
      description: string;
      input: S;
      table: string;
      columns: readonly string[];
      tenantColumn: string;
      filters: Readonly<Record<string, string>>;
      values: (
        args: z.output<S>,
      ) => Readonly<Record<string, string | number | boolean | null>>;
      authorize: (identity: Identity) => Promise<boolean>;
      limit?: number;
    }) {
      const table = identifier.parse(options.table);
      const columns = z.array(identifier).min(1).parse(options.columns);
      const tenantColumn = identifier.parse(options.tenantColumn);
      const filters = z.record(z.string(), identifier).parse(options.filters);
      const limit = z
        .number()
        .int()
        .min(1)
        .max(1000)
        .parse(options.limit ?? 100);
      const authorize = (identity: Identity) =>
        closed ? Promise.resolve(false) : options.authorize(identity);
      return readTool({
        ...options,
        authorize,
        async execute(args, identity, signal) {
          if (!(await abortable(() => authorize(identity), signal)))
            throw new Error("Database access denied");
          const values = options.values(args);
          const query = db(table)
            .select(columns)
            .where(tenantColumn, identity.tenantId)
            .limit(limit)
            .timeout(10_000);
          for (const [key, value] of Object.entries(values)) {
            const column = filters[key];
            if (!Object.hasOwn(filters, key) || column === undefined)
              throw new Error("Unreviewed database filter");
            query.where(column, value);
          }
          const rows: unknown = await abortable(() => query, signal);
          const output = JSON.stringify(rows);
          if (Buffer.byteLength(output) > 32_000)
            throw new Error("Database result too large");
          return output;
        },
      });
    },
  };
}
