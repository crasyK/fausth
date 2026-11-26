// Values (spec §1): canonical form (RFC 8785), hash, excerpt, member order and the argument text in both of its
// forms (§9.4).

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

/**
 * The argument text of a value in the form `model_order` (§9.4): compact JSON, members in member order (§1), strings
 * and numbers as in the canonical form; with `indented`, two-space indentation. For a JSON value this is exactly what
 * `JSON.stringify` writes: `Object.keys` gives the member order. Throws if the value has no canonical form.
 */
export function argumentText(value: unknown, indented = false): string {
  canonical(value);
  return indented ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** How a call's arguments go back to the model (§9.4): a harness's `argument_text`. */
export type ArgumentForm = "model_order" | "sorted_ascii" | "as_sent";
export const ARGUMENT_FORMS: readonly ArgumentForm[] = ["model_order", "sorted_ascii", "as_sent"];

/** A JSON value as Python's `json.loads` reads it: an integer token stays exact (its digits), any other number is a
 * double; a name that occurs twice keeps its last value. */
type PyValue = null | boolean | string | { int: string } | { float: number } | PyValue[] | Map<string, PyValue>;

/** Read JSON text keeping each number token's kind (§9.4, `sorted_ascii`). The text must be JSON (§1). */
function readTokens(text: string): PyValue {
  let i = 0;
  const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i += 1;
  };
  const string = (): string => {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    const s = JSON.parse(text.slice(i, j + 1)) as string;
    i = j + 1;
    return s;
  };
  const value = (): PyValue => {
    space();
    const c = text[i];
    if (c === "{") {
      i += 1;
      const members = new Map<string, PyValue>();
      space();
      if (text[i] === "}") {
        i += 1;
        return members;
      }
      for (;;) {
        space();
        const name = string();
        space();
        i += 1; // ":"
        members.set(name, value()); // a repeated name keeps its last value
        space();
        if (text[i++] === "}") return members;
      }
    }
    if (c === "[") {
      i += 1;
      const items: PyValue[] = [];
      space();
      if (text[i] === "]") {
        i += 1;
        return items;
      }
      for (;;) {
        items.push(value());
        space();
        if (text[i++] === "]") return items;
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m === null) throw new Error("not JSON");
    i = NUMBER.lastIndex;
    if (m[1] === undefined && m[2] === undefined) return { int: m[0] === "-0" ? "0" : m[0] };
    return { float: Number(m[0]) };
  };
  const v = value();
  space();
  if (i !== text.length) throw new Error("not JSON");
  return v;
}

/** Python's `float.__repr__` of a finite double: the shortest digits that read back as it (ECMAScript's), with a
 * decimal point, in exponent form when the decimal exponent is below -4 or at least 16. */
export function pythonFloat(x: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  if (x < 0) return `-${pythonFloat(-x)}`;
  const [mantissa, exp] = x.toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const e = Number(exp);
  if (e < -4 || e >= 16) {
    const head = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    return `${head}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  const n = e + 1; // digits before the decimal point
  if (n <= 0) return `0.${"0".repeat(-n)}${digits}`;
  if (n < digits.length) return `${digits.slice(0, n)}.${digits.slice(n)}`;
  return `${digits}${"0".repeat(n - digits.length)}.0`;
}

/** A string as Python's `json.dumps` writes it with `ensure_ascii`: every character outside U+0020–U+007E escaped,
 * a character above U+FFFF as its UTF-16 surrogate pair, hex digits in lowercase. */
function asciiQuote(s: string): string {
  let out = '"';
  for (let k = 0; k < s.length; k += 1) {
    const u = s.charCodeAt(k);
    const c = s[k]!;
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c === "\b") out += "\\b";
    else if (c === "\f") out += "\\f";
    else if (u >= 0x20 && u <= 0x7e) out += c;
    else out += `\\u${u.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

/** Python's string order: by code points, not UTF-16 code units. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let k = 0; k < Math.min(x.length, y.length); k += 1) if (x[k] !== y[k]) return x[k]! - y[k]!;
  return x.length - y.length;
}

function writePython(v: PyValue, newline: string | null): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return asciiQuote(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (newline === null) return `[${v.map((x) => writePython(x, null)).join(",")}]`;
    const inner = `${newline}  `;
    return `[${inner}${v.map((x) => writePython(x, inner)).join(`,${inner}`)}${newline}]`;
  }
  if (v instanceof Map) {
    if (v.size === 0) return "{}";
    const names = [...v.keys()].sort(byCodePoint);
    if (newline === null) return `{${names.map((k) => `${asciiQuote(k)}:${writePython(v.get(k)!, null)}`).join(",")}}`;
    const inner = `${newline}  `;
    return `{${inner}${names.map((k) => `${asciiQuote(k)}: ${writePython(v.get(k)!, inner)}`).join(`,${inner}`)}${newline}}`;
  }
  return "int" in v ? v.int : pythonFloat(v.float);
}

/**
 * The argument text in the form `sorted_ascii` (§9.4), from the model's argument text `raw`: what Python writes with
 * `json.dumps(json.loads(raw), separators=(",", ":"), sort_keys=True)`; with `indented`,
 * `json.dumps(json.loads(raw), indent=2, sort_keys=True)`. Throws if `raw` isn't JSON with a canonical form (§1).
 */
export function sortedAsciiText(raw: string, indented = false): string {
  canonical(JSON.parse(raw));
  return writePython(readTokens(raw), indented ? "\n" : null);
}
