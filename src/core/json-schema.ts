import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";

const withFormats = addFormats as unknown as <T>(ajv: T) => T;

export function compileSchema(schema: Record<string, unknown>) {
  const options = { strict: false, logger: false } as const;
  return withFormats(
    schema["$schema"] === "https://json-schema.org/draft/2020-12/schema"
      ? new Ajv2020(options)
      : new Ajv(options),
  ).compile(schema);
}
