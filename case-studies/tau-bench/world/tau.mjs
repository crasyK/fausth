#!/usr/bin/env node
/**
 * τ-bench retail world — faithful port of sierra-research/tau-bench
 * `tau_bench/envs/retail/tools/*.py` (commit pinned in ../upstream/upstream.lock.json).
 *
 * Fidelity contract (tested against upstream outputs in ../tests/tau-world.test.mjs):
 *   - Python value model: int → BigInt, float → number, dict → Map (insertion
 *     order), list → Array, None → null; the DB is parsed with that model.
 *   - Tool observations are byte-identical to upstream (`json.dumps` defaults,
 *     Python float repr, Python exception messages for argument errors).
 *   - `dataHash` reproduces upstream `consistent_hash(to_hashable(data))`.
 *   - `calculate` evaluates the upstream character set with Python semantics
 *     through a tiny parser. No dynamic code evaluation anywhere (the previous
 *     implementation compiled model-written input to JS: arbitrary code execution).
 *
 * CLI (cwd = workspace containing data/{orders,products,users}.json):
 *   node tau.mjs from-request                 # engine path: tau/request.json → stdout
 *   node tau.mjs call <tool> --args '<json>'  # one tool call (legacy: node tau.mjs <tool> --args …)
 *   node tau.mjs hash                         # upstream-compatible DB hash
 *   node tau.mjs apply-gold --actions '<json>'  # strict; per-action `expect_error`
 *   node tau.mjs describe-tools               # upstream tool specs (tools.json)
 *   node tau.mjs seed                         # copy pristine data/ + wiki.md into --cwd
 * Exit codes: 0 ok · 3 domain error ("Error: …" / "Unknown action …") · 2 usage · 1 crash.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Python value model helpers
// ---------------------------------------------------------------------------

/** Exception whose message is what Python's `str(e)` would print. */
export class PyError extends Error {}

export function isPyInt(v) {
  return typeof v === "bigint";
}
export function isPyFloat(v) {
  return typeof v === "number";
}

/** Python type name, for error messages. */
export function pyTypeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "bigint") return "int";
  if (typeof v === "number") return "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (v instanceof Map) return "dict";
  if (v instanceof PyTuple) return "tuple";
  return "object";
}

/** Only used by `calculate` (the empty tuple `()` is the only reachable tuple). */
export class PyTuple {
  constructor(items = []) {
    this.items = items;
  }
}

/** Python iteration over a value (list, str, dict keys). */
function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (v instanceof Map) return [...v.keys()];
  throw new PyError(`'${pyTypeName(v)}' object is not iterable`);
}

function pyLen(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return Array.from(v).length;
  if (v instanceof Map) return v.size;
  throw new PyError(`object of type '${pyTypeName(v)}' has no len()`);
}

/** Python `==` for the value model. */
export function pyEq(a, b) {
  if (typeof a === "bigint" || typeof b === "bigint" || typeof a === "number" || typeof b === "number") {
    const na = typeof a === "bigint" || typeof a === "number" || typeof a === "boolean";
    const nb = typeof b === "bigint" || typeof b === "number" || typeof b === "boolean";
    if (!na || !nb) return false;
    const x = typeof a === "boolean" ? (a ? 1n : 0n) : a;
    const y = typeof b === "boolean" ? (b ? 1n : 0n) : b;
    // eslint-disable-next-line eqeqeq
    return x == y; // BigInt/number loose equality compares mathematically
  }
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !pyEq(v, b.get(k))) return false;
    return true;
  }
  return a === b;
}

/** Python `seq.count(x)` for list / str. */
function pyCount(seq, x) {
  if (Array.isArray(seq)) return seq.filter((e) => pyEq(e, x)).length;
  if (typeof seq === "string") {
    if (typeof x !== "string") throw new PyError(`must be str, not ${pyTypeName(x)}`);
    if (x === "") return Array.from(seq).length + 1;
    let n = 0;
    for (let i = seq.indexOf(x); i >= 0; i = seq.indexOf(x, i + x.length)) n += 1;
    return n;
  }
  throw new PyError(`'${pyTypeName(seq)}' object has no attribute 'count'`);
}

/** Python `x in container` (dict keys / list / str substring). */
function pyIn(x, container) {
  if (container instanceof Map) {
    if (Array.isArray(x) || x instanceof Map) throw new PyError(`unhashable type: '${pyTypeName(x)}'`);
    return typeof x === "string" && container.has(x);
  }
  if (Array.isArray(container)) return container.some((e) => pyEq(e, x));
  if (typeof container === "string") {
    if (typeof x !== "string") throw new PyError(`'in <string>' requires string as left operand, not ${pyTypeName(x)}`);
    return container.includes(x);
  }
  throw new PyError(`argument of type '${pyTypeName(container)}' is not iterable`);
}

/** Python `sorted(iterable)` for strings / numbers (homogeneous). */
function pySorted(v) {
  const items = [...pyIter(v)];
  const types = new Set(items.map(pyTypeName));
  if (types.size > 1) {
    const [t1, t2] = [...types];
    throw new PyError(`'<' not supported between instances of '${t2}' and '${t1}'`);
  }
  if (types.has("str")) return items.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (types.has("int") || types.has("float")) return items.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (items.length > 1) throw new PyError(`'<' not supported between instances of '${[...types][0]}' and '${[...types][0]}'`);
  return items;
}

function pyLower(v) {
  if (typeof v !== "string") throw new PyError(`'${pyTypeName(v)}' object has no attribute 'lower'`);
  return v.toLowerCase();
}

/** Python `str(x)` for f-string interpolation. */
export function pyStr(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number") return pyFloatRepr(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null || v === undefined) return "None";
  return pyRepr(v);
}

/** Python `seq[i]` for lists (IndexError semantics). */
function pyIndex(seq, i) {
  if (!Array.isArray(seq)) throw new PyError(`'${pyTypeName(seq)}' object is not subscriptable`);
  if (i >= seq.length) throw new PyError("list index out of range");
  return seq[i];
}

/** Get a dict item with Python KeyError semantics. */
function getItem(container, key) {
  if (container instanceof Map) {
    if (typeof key !== "string" || !container.has(key)) throw new PyError(pyRepr(key));
    return container.get(key);
  }
  throw new PyError(`'${pyTypeName(container)}' object is not subscriptable`);
}

function setItem(map, key, value) {
  map.set(key, value);
}

// Arithmetic with Python int/float promotion (only what the tools need).
function pyAdd(a, b) {
  if (typeof a === "bigint" && typeof b === "bigint") return a + b;
  return Number(a) + Number(b);
}
function pySub(a, b) {
  if (typeof a === "bigint" && typeof b === "bigint") return a - b;
  return Number(a) - Number(b);
}
function pyAbs(a) {
  if (typeof a === "bigint") return a < 0n ? -a : a;
  return Math.abs(a);
}
function pyGt(a, b) {
  return a > b; // BigInt/number mixed comparison is mathematically exact in JS
}
function pyLt(a, b) {
  return a < b;
}

/**
 * Python `round(x, 2)`: ints are returned unchanged; floats are rounded to the
 * nearest double of the correctly-rounded decimal (half-even on exact ties).
 */
export function pyRound2(x) {
  if (typeof x === "bigint") return x;
  if (!Number.isFinite(x) || x === 0) return x;
  if (Math.abs(x) >= 2 ** 52) return x;
  // Exact ties at 2 decimals only exist for odd multiples of 1/8.
  const x8 = x * 8;
  if (Number.isInteger(x8) && x8 % 2 !== 0) {
    const neg = x < 0;
    const scaled = Math.abs(x) * 100; // exact: odd * 12.5
    const lo = Math.floor(scaled);
    const chosen = lo % 2 === 0 ? lo : lo + 1;
    const intPart = Math.floor(chosen / 100);
    const frac = String(chosen % 100).padStart(2, "0");
    return Number(`${neg ? "-" : ""}${intPart}.${frac}`);
  }
  return Number(x.toFixed(2));
}

// ---------------------------------------------------------------------------
// repr / json.dumps / hashing (Python-compatible)
// ---------------------------------------------------------------------------

/** Python `repr(float)` (shortest round-trip digits, Python formatting rules). */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x.toExponential());
  if (!m) throw new Error(`unexpected toExponential for ${x}`);
  const sign = m[1];
  const digits = m[2] + (m[3] ?? "");
  const e = Number(m[4]);
  if (e >= -4 && e < 16) {
    if (e >= 0) {
      const intPart = digits.slice(0, e + 1).padEnd(e + 1, "0");
      const frac = digits.slice(e + 1);
      return `${sign}${intPart}.${frac || "0"}`;
    }
    return `${sign}0.${"0".repeat(-e - 1)}${digits}`;
  }
  const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${mant}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python `repr(str)`. */
export function pyReprStr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x7f) out += ch;
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, "0")}`;
      else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
      else out += `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return out + quote;
}

/** Python `repr()` for the value model (lists/dicts as Python would print them). */
export function pyRepr(v) {
  if (typeof v === "string") return pyReprStr(v);
  if (typeof v === "number") return pyFloatRepr(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  if (v instanceof PyTuple) {
    return v.items.length === 1 ? `(${pyRepr(v.items[0])},)` : `(${v.items.map(pyRepr).join(", ")})`;
  }
  return String(v);
}

function jsonStr(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i); // UTF-16 code units: matches Python's surrogate-pair escaping
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function jsonFloat(x) {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  return pyFloatRepr(x);
}

/**
 * Python `json.dumps(value)` (defaults: ensure_ascii, ", " / ": " separators),
 * or with `indent` the `json.dump(..., indent=n)` layout.
 */
export function pyJsonDumps(value, opts = {}) {
  const indent = opts.indent ?? null;
  const enc = (v, level) => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return jsonFloat(v);
    if (typeof v === "string") return jsonStr(v);
    const isArr = Array.isArray(v);
    const entries = isArr ? v : v instanceof Map ? [...v] : Object.entries(v);
    if (entries.length === 0) return isArr ? "[]" : "{}";
    const item = (e) => (isArr ? enc(e, level + 1) : `${jsonStr(String(e[0]))}: ${enc(e[1], level + 1)}`);
    if (indent == null) return isArr ? `[${entries.map(item).join(", ")}]` : `{${entries.map(item).join(", ")}}`;
    const pad = " ".repeat(indent * (level + 1));
    const close = " ".repeat(indent * level);
    const body = entries.map((e) => pad + item(e)).join(",\n");
    return isArr ? `[\n${body}\n${close}]` : `{\n${body}\n${close}}`;
  };
  return enc(value, 0);
}

/**
 * Parse JSON with Python's `json.loads` typing: integers → BigInt, other
 * numbers → float, objects → Map (insertion order, last duplicate wins).
 */
const PLAIN_RE = /[^"\\]*/y;
const NUM_RE = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

export function pyJsonParse(text) {
  let i = 0;
  const s = String(text);
  const fail = (msg) => {
    throw new SyntaxError(`${msg} at position ${i}`);
  };
  const ws = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      const m = new Map();
      ws();
      if (s[i] === "}") {
        i++;
        return m;
      }
      for (;;) {
        ws();
        if (s[i] !== '"') fail("expected string key");
        const k = str();
        ws();
        if (s[i] !== ":") fail("expected ':'");
        i++;
        m.set(k, value());
        ws();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "}") {
          i++;
          return m;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const a = [];
      ws();
      if (s[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "]") {
          i++;
          return a;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    if (s.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (s.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (s.startsWith("null", i)) {
      i += 4;
      return null;
    }
    if (s.startsWith("NaN", i)) {
      i += 3;
      return NaN;
    }
    if (s.startsWith("Infinity", i)) {
      i += 8;
      return Infinity;
    }
    if (s.startsWith("-Infinity", i)) {
      i += 9;
      return -Infinity;
    }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(s);
    if (!m) fail("unexpected token");
    i += m[0].length;
    if (m[1] || m[2]) return Number(m[0]);
    return m[0].length < 16 ? BigInt(Number(m[0])) : BigInt(m[0]);
  };
  const str = () => {
    i++; // opening quote
    let out = "";
    for (;;) {
      PLAIN_RE.lastIndex = i;
      const m = PLAIN_RE.exec(s);
      const k = i + m[0].length; // first '"' or '\\' (or end)
      if (k >= s.length) fail("unterminated string");
      out += m[0];
      if (s[k] === '"') {
        i = k + 1;
        return out;
      }
      const e = s[k + 1];
      i = k + 2;
      if (e === "u") {
        out += String.fromCharCode(parseInt(s.slice(i, i + 4), 16));
        i += 4;
      } else {
        const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!(e in map)) fail("bad escape");
        out += map[e];
      }
    }
  };
  const v = value();
  ws();
  if (i !== s.length) fail("extra data");
  return v;
}

/** Python `str(to_hashable(x))` (tau_bench/envs/base.py). */
export function hashableStr(v) {
  if (v instanceof Map) {
    const keys = [...v.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = keys.map((k) => `(${pyReprStr(k)}, ${hashableStr(v.get(k))})`);
    return parts.length === 1 ? `(${parts[0]},)` : `(${parts.join(", ")})`;
  }
  if (Array.isArray(v)) {
    const parts = v.map(hashableStr);
    return parts.length === 1 ? `(${parts[0]},)` : `(${parts.join(", ")})`;
  }
  return pyRepr(v);
}

/** upstream `consistent_hash(to_hashable(data))` with data = {orders, products, users}. */
export function dataHash(data) {
  const root = new Map([
    ["orders", data.orders],
    ["products", data.products],
    ["users", data.users],
  ]);
  return createHash("sha256").update(hashableStr(root), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// calculate — Python semantics over the upstream character set, no eval
// ---------------------------------------------------------------------------

const CALC_CHARS = /^[0-9+\-*/(). ]*$/;
const MAX_EXPR_CHARS = 10_000; // DoS guard (deviation: upstream has no limit)
const MAX_INT_BITS = 4_000_000; // DoS guard for int ** int (deviation)

class PySyntaxError extends PyError {}

function tokenize(src) {
  /** @type {{ t: string, v?: string, pos: number }[]} */
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " ") {
      i++;
      continue;
    }
    if (c === "*" && src[i + 1] === "*") {
      toks.push({ t: "**", pos: i });
      i += 2;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      toks.push({ t: "//", pos: i });
      i += 2;
      continue;
    }
    if ("+-*/()".includes(c)) {
      toks.push({ t: c, pos: i });
      i++;
      continue;
    }
    const m = /^(?:\d+\.\d*|\.\d+|\d+)/.exec(src.slice(i));
    if (m) {
      toks.push({ t: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    // a lone "." (e.g. "..")
    throw new PySyntaxError("invalid syntax (<string>, line 1)");
  }
  return toks;
}

function bitLength(n) {
  return n === 0n ? 0 : (n < 0n ? -n : n).toString(2).length;
}

/** Python int → float with OverflowError. */
function intToFloat(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) throw new PyError("int too large to convert to float");
  return x;
}

/** Correctly rounded int / int (CPython long_true_divide semantics). */
function intTrueDiv(a, b) {
  if (b === 0n) throw new PyError("division by zero");
  const neg = a < 0n !== b < 0n;
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  if (x === 0n) return neg ? -0 : 0;
  const LIM = 1n << 53n;
  if (x <= LIM && y <= LIM) return (neg ? -1 : 1) * (Number(x) / Number(y));
  const shift = 55 - (bitLength(x) - bitLength(y));
  if (shift >= 0) x <<= BigInt(shift);
  else y <<= BigInt(-shift);
  let q = x / y;
  const sticky = x % y !== 0n;
  const extra = bitLength(q) - 53;
  if (extra > 0) {
    const mask = (1n << BigInt(extra)) - 1n;
    const low = q & mask;
    const half = 1n << BigInt(extra - 1);
    q >>= BigInt(extra);
    if (low > half || (low === half && (sticky || (q & 1n) === 1n))) q += 1n;
  }
  const exp = (extra > 0 ? extra : 0) - shift;
  const r = Number(q) * 2 ** exp;
  if (!Number.isFinite(r)) throw new PyError("integer division result too large for a float");
  return neg ? -r : r;
}

function floorDivInt(a, b) {
  if (b === 0n) throw new PyError("integer division or modulo by zero");
  let q = a / b;
  if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) q -= 1n;
  return q;
}

/** CPython float floor division (`_float_div_mod`). */
function floorDivFloat(vx, wx) {
  if (wx === 0) throw new PyError("float floor division by zero");
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod) {
    if (wx < 0 !== mod < 0) {
      mod += wx;
      div -= 1.0;
    }
  }
  let floordiv;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    floordiv = Math.sign(vx / wx) < 0 || Object.is(vx / wx, -0) ? -0 : 0;
  }
  return floordiv;
}

function floatPow(x, y) {
  if (x === 0 && y < 0) throw new PyError("0.0 cannot be raised to a negative power");
  if (x < 0 && Number.isFinite(y) && !Number.isInteger(y)) {
    throw new PyError("float() argument must be a string or a real number, not 'complex'");
  }
  const r = x ** y;
  if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) {
    throw new PyError("(34, 'Numerical result out of range')");
  }
  return r;
}

const OPNAME = { "+": "+", "-": "-", "*": "*", "/": "/", "//": "//", "**": "** or pow()" };

function binop(op, a, b) {
  const ta = a instanceof PyTuple;
  const tb = b instanceof PyTuple;
  if (ta || tb) {
    if (op === "+" && ta && tb) return new PyTuple([...a.items, ...b.items]);
    if (op === "*" && ta && typeof b === "bigint") return new PyTuple([]);
    if (op === "*" && tb && typeof a === "bigint") return new PyTuple([]);
    if (op === "*" && (ta || tb)) {
      const other = ta ? b : a;
      if (!(other instanceof PyTuple)) {
        throw new PyError(`can't multiply sequence by non-int of type '${pyTypeName(other)}'`);
      }
    }
    throw new PyError(
      `unsupported operand type(s) for ${OPNAME[op]}: '${pyTypeName(a)}' and '${pyTypeName(b)}'`,
    );
  }
  const ints = typeof a === "bigint" && typeof b === "bigint";
  switch (op) {
    case "+":
      return ints ? a + b : intOrFloat(a) + intOrFloat(b);
    case "-":
      return ints ? a - b : intOrFloat(a) - intOrFloat(b);
    case "*":
      return ints ? a * b : intOrFloat(a) * intOrFloat(b);
    case "/": {
      if (ints) return intTrueDiv(a, b);
      const y = intOrFloat(b);
      if (y === 0) throw new PyError("float division by zero");
      return intOrFloat(a) / y;
    }
    case "//":
      return ints ? floorDivInt(a, b) : floorDivFloat(intOrFloat(a), intOrFloat(b));
    case "**": {
      if (ints) {
        if (b < 0n) {
          if (a === 0n) throw new PyError("0.0 cannot be raised to a negative power");
          return floatPow(intToFloat(a), intToFloat(b));
        }
        if (bitLength(a) * Number(b) > MAX_INT_BITS) throw new PyError("int too large to convert to float");
        return a ** b;
      }
      return floatPow(intOrFloat(a), intOrFloat(b));
    }
    default:
      throw new Error(`bad op ${op}`);
  }
}

function intOrFloat(v) {
  return typeof v === "bigint" ? intToFloat(v) : v;
}

function parseCalc(src) {
  const toks = tokenize(src);
  if (toks.length === 0) throw new PySyntaxError("invalid syntax (<string>, line 0)");
  let p = 0;
  const peek = () => toks[p]?.t;
  const expect = (t) => {
    if (peek() !== t) throw new PySyntaxError("invalid syntax (<string>, line 1)");
    p++;
  };
  // Pre-scan parentheses for CPython's tokenizer-level messages.
  let depth = 0;
  for (const tk of toks) {
    if (tk.t === "(") depth++;
    if (tk.t === ")") {
      depth--;
      if (depth < 0) throw new PySyntaxError("unmatched ')' (<string>, line 1)");
    }
  }
  if (depth > 0) throw new PySyntaxError("'(' was never closed (<string>, line 1)");
  const atom = () => {
    const tk = toks[p];
    if (!tk) throw new PySyntaxError("invalid syntax (<string>, line 1)");
    if (tk.t === "num") {
      p++;
      const v = tk.v;
      if (v.includes(".")) return Number(v);
      if (v.length > 1 && v[0] === "0" && /[1-9]/.test(v)) {
        throw new PySyntaxError(
          "leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers (<string>, line 1)",
        );
      }
      return BigInt(v);
    }
    if (tk.t === "(") {
      p++;
      if (peek() === ")") {
        p++;
        return new PyTuple([]);
      }
      const v = expr();
      expect(")");
      return v;
    }
    throw new PySyntaxError("invalid syntax (<string>, line 1)");
  };
  const primary = () => {
    let node = atom();
    // call trailers: `x(...)` parses (and warns) in Python; it fails at runtime
    while (peek() === "(") {
      p++;
      const arg = peek() === ")" ? null : expr();
      expect(")");
      node = { op: "call", a: node, b: arg };
    }
    return node;
  };
  const power = () => {
    const base = primary();
    if (peek() === "**") {
      p++;
      const exp = factor();
      return { op: "**", a: base, b: exp };
    }
    return base;
  };
  const factor = () => {
    if (peek() === "+" || peek() === "-") {
      const op = toks[p].t;
      p++;
      return { op: `u${op}`, a: factor() };
    }
    return power();
  };
  const term = () => {
    let left = factor();
    while (peek() === "*" || peek() === "/" || peek() === "//") {
      const op = toks[p].t;
      p++;
      left = { op, a: left, b: factor() };
    }
    return left;
  };
  const expr = () => {
    let left = term();
    while (peek() === "+" || peek() === "-") {
      const op = toks[p].t;
      p++;
      left = { op, a: left, b: term() };
    }
    return left;
  };
  let tree;
  try {
    tree = expr();
    if (p !== toks.length) throw new PySyntaxError("invalid syntax (<string>, line 1)");
  } catch (e) {
    // CPython: two adjacent expressions inside brackets → "Perhaps you forgot a comma?"
    if (e instanceof PySyntaxError && e.message === "invalid syntax (<string>, line 1)" && p < toks.length) {
      const prev = toks[p - 1]?.t;
      let level = 0;
      for (let k = 0; k < p; k++) level += toks[k].t === "(" ? 1 : toks[k].t === ")" ? -1 : 0;
      if (level > 0 && toks[p].t === "num" && (prev === "num" || prev === ")")) {
        throw new PySyntaxError("invalid syntax. Perhaps you forgot a comma? (<string>, line 1)");
      }
    }
    throw e;
  }
  return tree;
}

function evalCalc(node) {
  if (typeof node === "bigint" || typeof node === "number" || node instanceof PyTuple) return node;
  if (node.op === "call") {
    const callee = evalCalc(node.a);
    if (node.b !== null) evalCalc(node.b);
    throw new PyError(`'${pyTypeName(callee)}' object is not callable`);
  }
  if (node.op === "u-" || node.op === "u+") {
    const v = evalCalc(node.a);
    if (v instanceof PyTuple) throw new PyError(`bad operand type for unary ${node.op[1]}: 'tuple'`);
    if (node.op === "u+") return v;
    return typeof v === "bigint" ? -v : -v;
  }
  return binop(node.op, evalCalc(node.a), evalCalc(node.b));
}

/**
 * upstream Calculate.invoke: character whitelist, Python evaluation,
 * `str(round(float(result), 2))`, `f"Error: {e}"` on failure.
 * @param {unknown} expression
 */
export function pyCalculate(expression) {
  if (typeof expression !== "string") {
    // `for char in expression` on a non-str (int/float/None) raises TypeError
    if (Array.isArray(expression)) {
      if (!expression.every((c) => typeof c === "string" && c.length && "0123456789+-*/(). ".includes(c))) {
        return "Error: invalid characters in expression";
      }
      return "Error: eval() arg 1 must be a string, bytes or code object";
    }
    return `Error: '${pyTypeName(expression)}' object is not iterable`;
  }
  if (!CALC_CHARS.test(expression)) return "Error: invalid characters in expression";
  if (expression.length > MAX_EXPR_CHARS) return "Error: expression too long";
  try {
    const v = evalCalc(parseCalc(expression));
    if (v instanceof PyTuple) {
      throw new PyError("float() argument must be a string or a real number, not 'tuple'");
    }
    const f = typeof v === "bigint" ? intToFloat(v) : v;
    return pyFloatRepr(pyRound2(f));
  } catch (e) {
    if (e instanceof PyError) return `Error: ${e.message}`;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Retail tools (1:1 with tau_bench/envs/retail/tools/*.py)
// ---------------------------------------------------------------------------

/** Parameter order of each upstream `invoke(data, ...)` signature. */
export const TOOL_PARAMS = Object.freeze({
  calculate: ["expression"],
  cancel_pending_order: ["order_id", "reason"],
  exchange_delivered_order_items: ["order_id", "item_ids", "new_item_ids", "payment_method_id"],
  find_user_id_by_email: ["email"],
  find_user_id_by_name_zip: ["first_name", "last_name", "zip"],
  get_order_details: ["order_id"],
  get_product_details: ["product_id"],
  get_user_details: ["user_id"],
  list_all_product_types: [],
  modify_pending_order_address: ["order_id", "address1", "address2", "city", "state", "country", "zip"],
  modify_pending_order_items: ["order_id", "item_ids", "new_item_ids", "payment_method_id"],
  modify_pending_order_payment: ["order_id", "payment_method_id"],
  modify_user_address: ["user_id", "address1", "address2", "city", "state", "country", "zip"],
  return_delivered_order_items: ["order_id", "item_ids", "payment_method_id"],
  think: ["thought"],
  transfer_to_human_agents: ["summary"],
});

/** Tools that write the database (graded by DB hash). */
export const MUTATING_TOOLS = new Set([
  "cancel_pending_order",
  "exchange_delivered_order_items",
  "modify_pending_order_address",
  "modify_pending_order_items",
  "modify_pending_order_payment",
  "modify_user_address",
  "return_delivered_order_items",
]);

/** upstream Env.terminate_tools for retail. */
export const TERMINATE_TOOLS = new Set(["transfer_to_human_agents"]);

function className(tool) {
  return tool
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

function quoteList(names) {
  const q = names.map((n) => `'${n}'`);
  if (q.length === 1) return q[0];
  if (q.length === 2) return `${q[0]} and ${q[1]}`;
  return `${q.slice(0, -1).join(", ")}, and ${q[q.length - 1]}`;
}

/** Python's TypeError messages for bad keyword arguments (3.10+ wording). */
function bindArgs(tool, kwargs) {
  const params = TOOL_PARAMS[tool];
  const owner = `${className(tool)}.invoke()`;
  for (const k of kwargs.keys()) {
    if (k === "data") throw new PyError(`${owner} got multiple values for keyword argument 'data'`);
    if (!params.includes(k)) throw new PyError(`${owner} got an unexpected keyword argument '${k}'`);
  }
  const missing = params.filter((p) => !kwargs.has(p));
  if (missing.length) {
    const noun = missing.length === 1 ? "argument" : "arguments";
    throw new PyError(`${owner} missing ${missing.length} required positional ${noun}: ${quoteList(missing)}`);
  }
  return params.map((p) => kwargs.get(p));
}

const dumps = (v) => pyJsonDumps(v);

function firstItem(order, itemId) {
  const hit = getItem(order, "items").find((it) => pyEq(getItem(it, "item_id"), itemId));
  if (!hit) throw new PyError("list index out of range");
  return hit;
}

const TOOLS = {
  calculate(data, expression) {
    return pyCalculate(expression);
  },

  cancel_pending_order(data, order_id, reason) {
    const orders = getItem(data, "orders");
    if (!pyIn(order_id, orders)) return "Error: order not found";
    const order = getItem(orders, order_id);
    if (getItem(order, "status") !== "pending") return "Error: non-pending order cannot be cancelled";
    if (!pyIn(reason, ["no longer needed", "ordered by mistake"])) return "Error: invalid reason";
    const refunds = [];
    for (const payment of pyIter(getItem(order, "payment_history"))) {
      const paymentId = getItem(payment, "payment_method_id");
      refunds.push(
        new Map([
          ["transaction_type", "refund"],
          ["amount", getItem(payment, "amount")],
          ["payment_method_id", paymentId],
        ]),
      );
      if (pyIn("gift_card", paymentId)) {
        const pm = getItem(getItem(getItem(getItem(data, "users"), getItem(order, "user_id")), "payment_methods"), paymentId);
        setItem(pm, "balance", pyAdd(getItem(pm, "balance"), getItem(payment, "amount")));
        setItem(pm, "balance", pyRound2(getItem(pm, "balance")));
      }
    }
    setItem(order, "status", "cancelled");
    setItem(order, "cancel_reason", reason);
    getItem(order, "payment_history").push(...refunds);
    return dumps(order);
  },

  exchange_delivered_order_items(data, order_id, item_ids, new_item_ids, payment_method_id) {
    const products = getItem(data, "products");
    const orders = getItem(data, "orders");
    const users = getItem(data, "users");
    if (!pyIn(order_id, orders)) return "Error: order not found";
    const order = getItem(orders, order_id);
    if (getItem(order, "status") !== "delivered") return "Error: non-delivered order cannot be exchanged";
    const allItemIds = getItem(order, "items").map((it) => getItem(it, "item_id"));
    for (const itemId of pyIter(item_ids)) {
      if (pyCount(item_ids, itemId) > pyCount(allItemIds, itemId)) return `Error: ${pyStr(itemId)} not found`;
    }
    if (pyLen(item_ids) !== pyLen(new_item_ids)) return "Error: the number of items to be exchanged should match";
    let diff = 0n;
    const olds = pyIter(item_ids);
    const news = pyIter(new_item_ids);
    for (let i = 0; i < Math.min(olds.length, news.length); i++) {
      const item = firstItem(order, olds[i]);
      const productId = getItem(item, "product_id");
      const variants = getItem(getItem(products, productId), "variants");
      if (!(pyIn(news[i], variants) && getItem(getItem(variants, news[i]), "available"))) {
        return `Error: new item ${pyStr(news[i])} not found or available`;
      }
      diff = pyAdd(diff, pySub(getItem(getItem(variants, news[i]), "price"), getItem(item, "price")));
    }
    diff = pyRound2(diff);
    const methods = getItem(getItem(users, getItem(order, "user_id")), "payment_methods");
    if (!pyIn(payment_method_id, methods)) return "Error: payment method not found";
    const pm = getItem(methods, payment_method_id);
    if (getItem(pm, "source") === "gift_card" && pyLt(getItem(pm, "balance"), diff)) {
      return "Error: insufficient gift card balance to pay for the price difference";
    }
    setItem(order, "status", "exchange requested");
    setItem(order, "exchange_items", pySorted(item_ids));
    setItem(order, "exchange_new_items", pySorted(new_item_ids));
    setItem(order, "exchange_payment_method_id", payment_method_id);
    setItem(order, "exchange_price_difference", diff);
    return dumps(order);
  },

  find_user_id_by_email(data, email) {
    for (const [userId, profile] of getItem(data, "users")) {
      if (pyLower(getItem(profile, "email")) === pyLower(email)) return userId;
    }
    return "Error: user not found";
  },

  find_user_id_by_name_zip(data, first_name, last_name, zip) {
    for (const [userId, profile] of getItem(data, "users")) {
      const name = getItem(profile, "name");
      if (
        pyLower(getItem(name, "first_name")) === pyLower(first_name) &&
        pyLower(getItem(name, "last_name")) === pyLower(last_name) &&
        pyEq(getItem(getItem(profile, "address"), "zip"), zip)
      ) {
        return userId;
      }
    }
    return "Error: user not found";
  },

  get_order_details(data, order_id) {
    const orders = getItem(data, "orders");
    if (pyIn(order_id, orders)) return dumps(getItem(orders, order_id));
    return "Error: order not found";
  },

  get_product_details(data, product_id) {
    const products = getItem(data, "products");
    if (pyIn(product_id, products)) return dumps(getItem(products, product_id));
    return "Error: product not found";
  },

  get_user_details(data, user_id) {
    const users = getItem(data, "users");
    if (pyIn(user_id, users)) return dumps(getItem(users, user_id));
    return "Error: user not found";
  },

  list_all_product_types(data) {
    const byName = new Map();
    for (const product of getItem(data, "products").values()) {
      byName.set(getItem(product, "name"), getItem(product, "product_id"));
    }
    const sorted = new Map([...byName].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    return dumps(sorted);
  },

  modify_pending_order_address(data, order_id, address1, address2, city, state, country, zip) {
    const orders = getItem(data, "orders");
    if (!pyIn(order_id, orders)) return "Error: order not found";
    const order = getItem(orders, order_id);
    if (getItem(order, "status") !== "pending") return "Error: non-pending order cannot be modified";
    setItem(
      order,
      "address",
      new Map([
        ["address1", address1],
        ["address2", address2],
        ["city", city],
        ["state", state],
        ["country", country],
        ["zip", zip],
      ]),
    );
    return dumps(order);
  },

  modify_pending_order_items(data, order_id, item_ids, new_item_ids, payment_method_id) {
    const products = getItem(data, "products");
    const orders = getItem(data, "orders");
    const users = getItem(data, "users");
    if (!pyIn(order_id, orders)) return "Error: order not found";
    const order = getItem(orders, order_id);
    if (getItem(order, "status") !== "pending") return "Error: non-pending order cannot be modified";
    const allItemIds = getItem(order, "items").map((it) => getItem(it, "item_id"));
    for (const itemId of pyIter(item_ids)) {
      if (pyCount(item_ids, itemId) > pyCount(allItemIds, itemId)) return `Error: ${pyStr(itemId)} not found`;
    }
    if (pyLen(item_ids) !== pyLen(new_item_ids)) return "Error: the number of items to be exchanged should match";
    let diff = 0n;
    const olds = pyIter(item_ids);
    const news = pyIter(new_item_ids);
    const n = Math.min(olds.length, news.length);
    for (let i = 0; i < n; i++) {
      const item = firstItem(order, olds[i]);
      const variants = getItem(getItem(products, getItem(item, "product_id")), "variants");
      if (!(pyIn(news[i], variants) && getItem(getItem(variants, news[i]), "available"))) {
        return `Error: new item ${pyStr(news[i])} not found or available`;
      }
      diff = pyAdd(diff, pySub(getItem(getItem(variants, news[i]), "price"), getItem(item, "price")));
    }
    const methods = getItem(getItem(users, getItem(order, "user_id")), "payment_methods");
    if (!pyIn(payment_method_id, methods)) return "Error: payment method not found";
    const pm = getItem(methods, payment_method_id);
    if (getItem(pm, "source") === "gift_card" && pyLt(getItem(pm, "balance"), diff)) {
      return "Error: insufficient gift card balance to pay for the new item";
    }
    getItem(order, "payment_history").push(
      new Map([
        ["transaction_type", pyGt(diff, 0n) ? "payment" : "refund"],
        ["amount", pyAbs(diff)],
        ["payment_method_id", payment_method_id],
      ]),
    );
    if (getItem(pm, "source") === "gift_card") {
      setItem(pm, "balance", pySub(getItem(pm, "balance"), diff));
      setItem(pm, "balance", pyRound2(getItem(pm, "balance")));
    }
    for (let i = 0; i < n; i++) {
      const item = firstItem(order, olds[i]);
      const variant = getItem(getItem(getItem(products, getItem(item, "product_id")), "variants"), news[i]);
      setItem(item, "item_id", news[i]);
      setItem(item, "price", getItem(variant, "price"));
      setItem(item, "options", getItem(variant, "options"));
    }
    setItem(order, "status", "pending (item modified)");
    return dumps(order);
  },

  modify_pending_order_payment(data, order_id, payment_method_id) {
    const orders = getItem(data, "orders");
    if (!pyIn(order_id, orders)) return "Error: order not found";
    const order = getItem(orders, order_id);
    if (getItem(order, "status") !== "pending") return "Error: non-pending order cannot be modified";
    const users = getItem(data, "users");
    const methods = getItem(getItem(users, getItem(order, "user_id")), "payment_methods");
    if (!pyIn(payment_method_id, methods)) return "Error: payment method not found";
    const history = getItem(order, "payment_history");
    if (pyLen(history) > 1 || getItem(pyIndex(history, 0), "transaction_type") !== "payment") {
      return "Error: there should be exactly one payment for a pending order";
    }
    if (pyEq(getItem(history[0], "payment_method_id"), payment_method_id)) {
      return "Error: the new payment method should be different from the current one";
    }
    const amount = getItem(history[0], "amount");
    const pm = getItem(methods, payment_method_id);
    if (getItem(pm, "source") === "gift_card" && pyLt(getItem(pm, "balance"), amount)) {
      return "Error: insufficient gift card balance to pay for the order";
    }
    history.push(
      new Map([
        ["transaction_type", "payment"],
        ["amount", amount],
        ["payment_method_id", payment_method_id],
      ]),
      new Map([
        ["transaction_type", "refund"],
        ["amount", amount],
        ["payment_method_id", getItem(history[0], "payment_method_id")],
      ]),
    );
    if (getItem(pm, "source") === "gift_card") {
      setItem(pm, "balance", pySub(getItem(pm, "balance"), amount));
      setItem(pm, "balance", pyRound2(getItem(pm, "balance")));
    }
    if (pyIn("gift_card", getItem(history[0], "payment_method_id"))) {
      const old = getItem(methods, getItem(history[0], "payment_method_id"));
      setItem(old, "balance", pyAdd(getItem(old, "balance"), amount));
      setItem(old, "balance", pyRound2(getItem(old, "balance")));
    }
    return dumps(order);
  },

  modify_user_address(data, user_id, address1, address2, city, state, country, zip) {
    const users = getItem(data, "users");
    if (!pyIn(user_id, users)) return "Error: user not found";
    const user = getItem(users, user_id);
    setItem(
      user,
      "address",
      new Map([
        ["address1", address1],
        ["address2", address2],
        ["city", city],
        ["state", state],
        ["country", country],
        ["zip", zip],
      ]),
    );
    return dumps(user);
  },

  return_delivered_order_items(data, order_id, item_ids, payment_method_id) {
    const orders = getItem(data, "orders");
    if (!pyIn(order_id, orders)) return "Error: order not found";
    const order = getItem(orders, order_id);
    if (getItem(order, "status") !== "delivered") return "Error: non-delivered order cannot be returned";
    const methods = getItem(getItem(getItem(data, "users"), getItem(order, "user_id")), "payment_methods");
    if (!pyIn(payment_method_id, methods)) return "Error: payment method not found";
    if (
      !pyIn("gift_card", payment_method_id) &&
      !pyEq(payment_method_id, getItem(pyIndex(getItem(order, "payment_history"), 0), "payment_method_id"))
    ) {
      return "Error: payment method should be either the original payment method or a gift card";
    }
    const allItemIds = getItem(order, "items").map((it) => getItem(it, "item_id"));
    for (const itemId of pyIter(item_ids)) {
      if (pyCount(item_ids, itemId) > pyCount(allItemIds, itemId)) return "Error: some item not found";
    }
    setItem(order, "status", "return requested");
    setItem(order, "return_items", pySorted(item_ids));
    setItem(order, "return_payment_method_id", payment_method_id);
    return dumps(order);
  },

  think(data, thought) {
    return "";
  },

  transfer_to_human_agents(data, summary) {
    return "Transfer successful";
  },
};

/**
 * Invoke one upstream tool exactly as `Env.step` does: unknown names →
 * "Unknown action <name>", Python exceptions → "Error: <str(e)>".
 * Mutates `data` in place for mutating tools.
 * @param {{ orders: Map, products: Map, users: Map }} data
 * @param {string} name
 * @param {Map<string, unknown> | Record<string, unknown>} kwargs  (Map from pyJsonParse preferred)
 * @returns {string}
 */
export function invokeTool(data, name, kwargs) {
  if (!Object.hasOwn(TOOLS, name)) return `Unknown action ${name}`;
  const kw = kwargs instanceof Map ? kwargs : toPy(kwargs ?? {});
  const dataMap = new Map([
    ["orders", data.orders],
    ["products", data.products],
    ["users", data.users],
  ]);
  try {
    if (!(kw instanceof Map)) throw new PyError(`${className(name)}.invoke() argument after ** must be a mapping, not ${pyTypeName(kw)}`);
    const args = bindArgs(name, kw);
    return TOOLS[name](dataMap, ...args);
  } catch (e) {
    if (e instanceof PyError) return `Error: ${e.message}`;
    throw e;
  }
}

/** Convert plain JS JSON values to the Python value model (integers → BigInt). */
export function toPy(v) {
  if (v instanceof Map || typeof v === "bigint") return v;
  if (Array.isArray(v)) return v.map(toPy);
  if (v && typeof v === "object") return new Map(Object.entries(v).map(([k, x]) => [k, toPy(x)]));
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return v;
}

export function isErrorObservation(obs) {
  return obs.startsWith("Error") || obs.startsWith("Unknown action");
}

// ---------------------------------------------------------------------------
// Data I/O
// ---------------------------------------------------------------------------

export const SEED_DATA_DIR = join(here, "data");
const COLLECTIONS = ["orders", "products", "users"];

/** Load data/{orders,products,users}.json with Python typing. */
export function loadDataDir(dir) {
  const out = {};
  for (const c of COLLECTIONS) out[c] = pyJsonParse(readFileSync(join(dir, `${c}.json`), "utf8"));
  return /** @type {{ orders: Map<string, any>, products: Map<string, any>, users: Map<string, any> }} */ (out);
}

export function saveDataDir(dir, data) {
  mkdirSync(dir, { recursive: true });
  for (const c of COLLECTIONS) {
    const p = join(dir, `${c}.json`);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, pyJsonDumps(data[c], { indent: 4 }) + "\n");
    renameSync(tmp, p);
  }
}

let seedCache = null;
/** Fresh deep copy of the pristine upstream DB. */
export function loadSeedData() {
  if (!seedCache) {
    seedCache = {};
    for (const c of COLLECTIONS) seedCache[c] = readFileSync(join(SEED_DATA_DIR, `${c}.json`), "utf8");
  }
  const out = {};
  for (const c of COLLECTIONS) out[c] = pyJsonParse(seedCache[c]);
  return /** @type {{ orders: Map<string, any>, products: Map<string, any>, users: Map<string, any> }} */ (out);
}

// ---------------------------------------------------------------------------
// Gold replay (grader + self-test)
// ---------------------------------------------------------------------------

export class GoldReplayError extends Error {}

/**
 * Replay gold actions as upstream `calculate_reward` does (terminate tools are
 * skipped). Fails loudly when an action's outcome differs from the recorded
 * upstream expectation (`expect_error`, a string prefix or false) — so a
 * missing/broken tool can never silently turn the gold state into a no-op.
 * Actions without an expectation must succeed.
 * @param {{ orders: Map, products: Map, users: Map }} data mutated in place
 * @param {{ name: string, kwargs?: unknown, expect_error?: string | false }[]} actions
 */
export function applyGoldActions(data, actions) {
  const steps = [];
  for (const [i, a] of actions.entries()) {
    const name = String(a.name);
    if (TERMINATE_TOOLS.has(name)) {
      steps.push({ name, skipped: "terminate_tool" });
      continue;
    }
    if (!Object.hasOwn(TOOLS, name)) {
      throw new GoldReplayError(`gold action ${i} (${name}): unknown tool in this world`);
    }
    const obs = invokeTool(data, name, toPy(a.kwargs ?? {}));
    const err = isErrorObservation(obs);
    const expected = a.expect_error ?? false;
    if (err && expected === false) {
      throw new GoldReplayError(`gold action ${i} (${name}) failed unexpectedly: ${obs}`);
    }
    if (!err && expected !== false) {
      throw new GoldReplayError(`gold action ${i} (${name}) succeeded but upstream errors with: ${expected}`);
    }
    if (err && typeof expected === "string" && !obs.startsWith(expected)) {
      throw new GoldReplayError(`gold action ${i} (${name}) error differs from upstream: ${obs} ≠ ${expected}`);
    }
    steps.push({ name, error: err ? obs : null, mutating: MUTATING_TOOLS.has(name) });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const out = { cwd: process.cwd(), _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--args") out.args = argv[++i];
    else if (a === "--actions") out.actions = argv[++i];
    else if (a === "--seed") out.seed = argv[++i];
    else out._.push(a);
  }
  return out;
}

function ensureData(cwd, seedDir) {
  const dataDir = join(cwd, "data");
  if (existsSync(join(dataDir, "orders.json"))) return;
  if (!existsSync(join(seedDir, "orders.json"))) {
    throw new Error(`no data/ in ${cwd} and no seed data at ${seedDir}`);
  }
  mkdirSync(dataDir, { recursive: true });
  cpSync(seedDir, dataDir, { recursive: true });
}

function terminatedState(cwd) {
  const p = join(cwd, "tau", "state.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")).terminated ?? null;
  } catch {
    return null;
  }
}

/**
 * Execute one tool call against a workspace DB, persisting mutations and the
 * action log. After a terminate tool (transfer_to_human_agents) the episode is
 * over (upstream `done=True`), so further calls are refused.
 */
export function callInWorkspace(cwd, tool, kwargsJsonText) {
  const ended = terminatedState(cwd);
  let result;
  let kwargs;
  if (ended) {
    result = `Error: the conversation has ended (${ended}); no further actions are possible`;
  } else {
    kwargs = pyJsonParse(kwargsJsonText || "{}");
    const data = loadDataDir(join(cwd, "data"));
    result = invokeTool(data, tool, kwargs);
    if (MUTATING_TOOLS.has(tool) && !isErrorObservation(result)) saveDataDir(join(cwd, "data"), data);
    if (TERMINATE_TOOLS.has(tool) && !isErrorObservation(result)) {
      mkdirSync(join(cwd, "tau"), { recursive: true });
      writeFileSync(join(cwd, "tau", "state.json"), JSON.stringify({ terminated: tool }) + "\n");
    }
  }
  mkdirSync(join(cwd, "tau"), { recursive: true });
  writeFileSync(join(cwd, "tau", "response.txt"), result);
  appendFileSync(
    join(cwd, "tau", "actions.jsonl"),
    JSON.stringify({ name: tool, kwargs: kwargsJsonText ? JSON.parse(kwargsJsonText) : {}, result }) + "\n",
  );
  return result;
}

export function main(argv) {
  const args = parseArgs(argv);
  const cwd = resolve(args.cwd);
  const seedDir = resolve(args.seed ?? SEED_DATA_DIR);
  const cmd = args._[0];
  if (!cmd) {
    console.error("usage: tau.mjs [--cwd dir] from-request | call <tool> --args <json> | hash | apply-gold --actions <json> | describe-tools | seed");
    return 2;
  }
  if (cmd === "describe-tools") {
    process.stdout.write(readFileSync(join(here, "tools.json"), "utf8"));
    return 0;
  }
  if (cmd === "seed") {
    mkdirSync(join(cwd, "data"), { recursive: true });
    cpSync(seedDir, join(cwd, "data"), { recursive: true });
    const wiki = join(here, "wiki.md");
    if (existsSync(wiki)) writeFileSync(join(cwd, "wiki.md"), readFileSync(wiki));
    console.log(JSON.stringify({ ok: true, cwd }));
    return 0;
  }
  ensureData(cwd, seedDir);
  if (cmd === "hash") {
    console.log(dataHash(loadDataDir(join(cwd, "data"))));
    return 0;
  }
  if (cmd === "apply-gold") {
    const actions = JSON.parse(args.actions || "[]");
    const data = loadDataDir(join(cwd, "data"));
    try {
      applyGoldActions(data, actions);
    } catch (e) {
      console.error(String(e?.message ?? e));
      return 1;
    }
    saveDataDir(join(cwd, "data"), data);
    console.log(JSON.stringify({ ok: true, hash: dataHash(data) }));
    return 0;
  }
  let tool;
  let kwText;
  if (cmd === "from-request") {
    const reqPath = join(cwd, "tau", "request.json");
    if (!existsSync(reqPath)) {
      console.log("Error: missing tau/request.json");
      return 3;
    }
    const raw = readFileSync(reqPath, "utf8");
    const req = JSON.parse(raw);
    tool = String(req.tool ?? req.name ?? "");
    const kw = req.kwargs ?? req.args ?? {};
    kwText = JSON.stringify(kw);
  } else if (cmd === "call") {
    tool = String(args._[1] ?? "");
    kwText = args.args ?? "{}";
  } else {
    tool = cmd; // legacy: tau.mjs <tool> --args <json>
    kwText = args.args ?? "{}";
  }
  const result = callInWorkspace(cwd, tool, kwText);
  console.log(result);
  return isErrorObservation(result) ? 3 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  }
}
