// JSON Schema 2020-12 for tool and handler schemas (spec §3.2).
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical } from "./values.js";

export type Check = (value: unknown) => boolean;

/** Compile a schema. Throws if it doesn't compile (bad `$ref`, invalid `pattern`, …). */
export function compileSchema(schema: object): Check {
  // One compiler per schema, so two tools may reuse an `$id`. The harness schema has already
  // checked every schema against the 2020-12 meta-schema; `format` is an annotation.
  const ajv = new Ajv2020({ strict: false, validateSchema: false, validateFormats: false });
  const validate = ajv.compile(schema);
  return (value) => validate(value) === true;
}

const TYPE_NAMES: Record<string, string> = {
  string: "a string", integer: "an integer", number: "a number", boolean: "a boolean",
  object: "an object", array: "an array", null: "null",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number";
/** The order of canonical JSON (§1): UTF-16 code units, JavaScript's default string order. */
const ordered = (names: string[]): string[] => [...names].sort();

function hasType(v: unknown, t: string): boolean {
  switch (t) {
    case "string": return typeof v === "string";
    case "integer": return isNumber(v) && Number.isInteger(v);
    case "number": return isNumber(v);
    case "boolean": return typeof v === "boolean";
    case "object": return isObject(v);
    case "array": return Array.isArray(v);
    case "null": return v === null;
    default: return false;
  }
}

/** The first row of §8.1's table that the value fails, or null. */
function memberReason(p: unknown, v: unknown): string | null {
  if (p === false) return "not allowed";
  if (!isObject(p)) return null;
  const types = typeof p.type === "string" ? [p.type] : p.type;
  if (Array.isArray(types) && types.length > 0 && !types.some((t) => hasType(v, String(t)))) {
    return "must be " + types.map((t) => TYPE_NAMES[String(t)] ?? String(t)).join(" or ");
  }
  if (Array.isArray(p.enum) && !p.enum.map((e) => canonical(e)).includes(canonical(v))) {
    return "must be one of " + p.enum.map((e) => canonical(e)).join(", ");
  }
  if (Object.hasOwn(p, "const") && canonical(p.const) !== canonical(v)) return "must be " + canonical(p.const);
  if (typeof v === "string") {
    const k = [...v].length; // code points
    if (isNumber(p.minLength) && k < p.minLength) return `at least ${canonical(p.minLength)} characters (it has ${k})`;
    if (isNumber(p.maxLength) && k > p.maxLength) return `at most ${canonical(p.maxLength)} characters (it has ${k})`;
    if (typeof p.pattern === "string" && !new RegExp(p.pattern, "u").test(v)) return `must match the pattern ${p.pattern}`;
  }
  if (isNumber(v)) {
    const rows: [string, (n: number) => boolean, string][] = [
      ["minimum", (n) => v < n, "at least"], ["exclusiveMinimum", (n) => v <= n, "more than"],
      ["maximum", (n) => v > n, "at most"], ["exclusiveMaximum", (n) => v >= n, "less than"],
    ];
    for (const [key, fails, word] of rows) {
      const n = p[key];
      if (isNumber(n) && fails(n)) return `${word} ${canonical(n)}`;
    }
  }
  if (Array.isArray(v)) {
    const k = v.length;
    if (isNumber(p.minItems) && k < p.minItems) return `at least ${canonical(p.minItems)} items (it has ${k})`;
    if (isNumber(p.maxItems) && k > p.maxItems) return `at most ${canonical(p.maxItems)} items (it has ${k})`;
  }
  return null;
}

/** Why arguments fail a tool's input schema (spec §8.1), for arguments JSON Schema has rejected. */
export function argumentReasons(schema: unknown, args: unknown): string {
  if (!isObject(schema)) return "does not match the input schema";
  if (schema.type === "object" && !isObject(args)) return "the arguments must be a JSON object";
  const out: string[] = [];
  if (isObject(args)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === "string" && !Object.hasOwn(args, name)) out.push(`missing required member ${name}`);
    }
    if (schema.additionalProperties === false && !Object.hasOwn(schema, "patternProperties")) {
      const names = ordered(Object.keys(props)).join(", ");
      for (const name of ordered(Object.keys(args))) {
        if (!Object.hasOwn(props, name)) out.push(`unknown member ${name} ` + (names ? `(members: ${names})` : "(no members)"));
      }
    }
    for (const name of ordered(Object.keys(args))) {
      if (Object.hasOwn(props, name)) {
        const reason = memberReason(props[name], args[name]);
        if (reason !== null) out.push(`${name}: ${reason}`);
      }
    }
  }
  return out.length ? out.join("; ") : "does not match the input schema";
}
