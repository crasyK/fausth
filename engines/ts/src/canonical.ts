import { createHash } from "node:crypto";
import { INT53_MAX, INT53_MIN } from "./types.js";

function assertIntegerDeep(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`Non-integer number at ${path}: ${value}`);
    }
    if (value < INT53_MIN || value > INT53_MAX) {
      throw new Error(`Integer out of portable int53 range at ${path}: ${value}`);
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

/** Compact JSON with sorted object keys (canonical form). */
export function canonicalJson(value: unknown): string {
  assertIntegerDeep(value, "$");
  return JSON.stringify(sortKeys(value));
}

/** Deep equality via canonical JSON (portable across runtimes). */
export function deepEq(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

export function stateHash(state: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

export function eventLine(event: unknown): string {
  return canonicalJson(event);
}
