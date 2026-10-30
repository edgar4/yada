import { expect, it } from "vitest";
import knex from "knex";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createReadDatabase } from "../src/connectors/database.js";

for (const driver of ["postgres", "mysql"] as const) {
  const configured =
    process.env[
      driver === "postgres" ? "YADA_TEST_POSTGRES" : "YADA_TEST_MYSQL"
    ];
  it.skipIf(!configured)(
    `reads a real ${driver} business database without migrations`,
    async () => {
      const url = z.string().min(1).parse(configured);
      const setup = knex({
        client: driver === "postgres" ? "pg" : "mysql2",
        connection: url,
      });
      const table = `connector_${randomBytes(8).toString("hex")}`;
      const database = createReadDatabase({ driver, url });
      try {
        await setup.schema.createTable(table, (builder) => {
          builder.string("tenant");
          builder.string("id");
          builder.string("private");
        });
        await setup(table).insert([
          { tenant: "t", id: "a", private: "secret" },
          { tenant: "other", id: "a", private: "hidden" },
        ]);
        const tool = database.tool({
          name: "lookup",
          description: "Lookup",
          input: z.strictObject({ id: z.string() }),
          table,
          columns: ["id"],
          tenantColumn: "tenant",
          filters: { id: "id" },
          values: (args) => ({ id: args.id }),
          authorize: () => Promise.resolve(true),
        });
        const identity = { actorId: "actor", tenantId: "t" };
        expect(
          await tool.execute({ id: "a" }, identity, AbortSignal.timeout(5000)),
        ).toBe('[{"id":"a"}]');
        expect(
          await tool.execute(
            { id: "a' OR 1=1 --" },
            identity,
            AbortSignal.timeout(5000),
          ),
        ).toBe("[]");
      } finally {
        await database.close();
        await setup.schema.dropTableIfExists(table);
        await setup.destroy();
      }
    },
  );
}
