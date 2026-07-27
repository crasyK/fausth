import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: false });
addFormats(ajv);

/** Validate data against a JSON Schema object. Empty/missing schema → ok. */
export function validateAgainstSchema(
  schema: Record<string, unknown> | undefined,
  data: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  if (!schema || Object.keys(schema).length === 0) {
    return { ok: true };
  }
  // Default: reject unknown properties unless schema allows them
  const effective = {
    ...schema,
    type: schema.type ?? "object",
    additionalProperties:
      schema.additionalProperties !== undefined ? schema.additionalProperties : false,
  };
  const validate = ajv.compile(effective);
  const ok = validate(data);
  if (ok) return { ok: true };
  return {
    ok: false,
    errors: (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`),
  };
}
