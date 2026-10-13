import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { canonicalJson } from "./canonical.js";

/**
 * Tool I/O schema validation (spec-v0.3 §2.3).
 *
 * - Missing top-level `type` ⇒ `object`; missing top-level `additionalProperties` ⇒ `false`.
 * - `format` is an annotation only (never validated) — same as the Python engine.
 * - A top-level `$id` is ignored (tool schemas are anonymous), so two tools may reuse one.
 * - Compiled validators are cached by the canonical JSON of the effective schema; a schema
 *   that cannot be compiled is reported (`compileError`), never thrown.
 */
function newAjv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: false, validateSchema: false, validateFormats: false });
}

let ajv = newAjv();
const cache = new Map<string, ValidateFunction | { compileError: string }>();
const MAX_CACHE = 512;

export type SchemaCheck =
  | { ok: true }
  | { ok: false; errors: string[]; compileError?: false }
  | { ok: false; errors: string[]; compileError: true };

function effectiveSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const effective: Record<string, unknown> = {
    ...schema,
    type: schema.type ?? "object",
    additionalProperties:
      schema.additionalProperties !== undefined ? schema.additionalProperties : false,
  };
  delete effective.$id;
  delete effective.$schema;
  return effective;
}

function compiled(schema: Record<string, unknown>): ValidateFunction | { compileError: string } {
  const effective = effectiveSchema(schema);
  let key: string;
  try {
    key = canonicalJson(effective);
  } catch (e) {
    return { compileError: e instanceof Error ? e.message : String(e) };
  }
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size >= MAX_CACHE) {
    // Bounded memory: start a fresh compiler + cache (compiled schemas live inside Ajv).
    cache.clear();
    ajv = newAjv();
  }
  let entry: ValidateFunction | { compileError: string };
  try {
    entry = ajv.compile(effective);
  } catch (e) {
    entry = { compileError: e instanceof Error ? e.message : String(e) };
  }
  cache.set(key, entry);
  return entry;
}

/** Validate data against a JSON Schema object. Empty/missing schema → ok. Never throws. */
export function validateAgainstSchema(
  schema: Record<string, unknown> | undefined,
  data: unknown,
): SchemaCheck {
  if (!schema || Object.keys(schema).length === 0) {
    return { ok: true };
  }
  const v = compiled(schema);
  if ("compileError" in v) {
    return { ok: false, errors: [`schema does not compile: ${v.compileError}`], compileError: true };
  }
  let ok: boolean;
  try {
    ok = v(data) as boolean;
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  if (ok) return { ok: true };
  return {
    ok: false,
    errors: (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()),
  };
}

/** Compile-only check used by the harness validator (spec-v0.3 §2.6 rule 15). */
export function schemaCompiles(schema: Record<string, unknown> | undefined): string | null {
  if (!schema || Object.keys(schema).length === 0) return null;
  const v = compiled(schema);
  return "compileError" in v ? v.compileError : null;
}

/** Number of cached compiled schemas (for tests). */
export function schemaCacheSize(): number {
  return cache.size;
}
