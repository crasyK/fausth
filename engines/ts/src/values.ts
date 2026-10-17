// Values (spec §1): canonical form (RFC 8785), hash, excerpt.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const LONE_SURROGATE = /\p{Cs}/u;

/** The canonical form of a JSON value. Throws if the value has none (§1). */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // JSON.stringify formats finite numbers with ECMAScript Number::toString; -0 becomes "0".
      if (!Number.isFinite(value)) throw new Error("a non-finite number has no canonical form");
      return JSON.stringify(value);
    case "string":
      return quote(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) break;
      const obj = value as Record<string, unknown>;
      // The default sort compares UTF-16 code units, which is what RFC 8785 asks for.
      const members = Object.keys(obj).sort().map((k) => `${quote(k)}:${canonical(obj[k])}`);
      return `{${members.join(",")}}`;
    }
  }
  throw new Error(`not a JSON value: ${typeof value}`);
}

function quote(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new Error("a string with a lone surrogate has no canonical form");
  return JSON.stringify(s);
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of the canonical form (§1). */
export async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const TRUNCATED = "…[truncated]";

/** `s` if it has at most `n` code points, else its first `n` code points and `…[truncated]` (§1). */
export function excerpt(s: string, n: number): string {
  const points = Array.from(s);
  return points.length <= n ? s : points.slice(0, n).join("") + TRUNCATED;
}
