import { createHash } from "node:crypto";

function assertIntegerDeep(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`Non-integer number at ${path}: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertIntegerDeep(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertIntegerDeep(v, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`Unsupported type at ${path}: ${typeof value}`);
}

/** Compact JSON with sorted object keys (canonical form). */
export function canonicalJson(value: unknown): string {
  assertIntegerDeep(value, "$");
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

export function stateHash(state: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

export function eventLine(event: unknown): string {
  return canonicalJson(event);
}
