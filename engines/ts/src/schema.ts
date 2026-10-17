// JSON Schema 2020-12 for tool and handler schemas (spec §3.2).
import { Ajv2020 } from "ajv/dist/2020.js";

export type Check = (value: unknown) => boolean;

/** Compile a schema. Throws if it doesn't compile (bad `$ref`, invalid `pattern`, …). */
export function compileSchema(schema: object): Check {
  // One compiler per schema, so two tools may reuse an `$id`. The harness schema has already
  // checked every schema against the 2020-12 meta-schema; `format` is an annotation.
  const ajv = new Ajv2020({ strict: false, validateSchema: false, validateFormats: false });
  const validate = ajv.compile(schema);
  return (value) => validate(value) === true;
}
