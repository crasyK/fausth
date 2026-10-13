import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  compareCodePoints,
  cpLength,
  deepEq,
  excerpt,
  stateHash,
  toCanonical,
  TRUNCATION_SUFFIX,
} from "./canonical.js";
import { evalPredicate, getPath, MISSING, isMissing } from "./predicates.js";
import type { Snapshot } from "./types.js";
import { INT53_MAX, buildMessageSnapshot } from "./types.js";

describe("canonicalJson (spec-v0.3 §1)", () => {
  it("sorts keys", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("D1: sorts keys by Unicode code point, not UTF-16 code unit", () => {
    // U+FF61 (BMP) < U+1F600 (astral) by code point; UTF-16 order would put the astral key first
    // because its lead surrogate 0xD83D < 0xFF61.
    const astral = "\u{1F600}";
    const bmp = "｡";
    assert.equal(canonicalJson({ [astral]: 1, [bmp]: 2 }), `{"${bmp}":2,"${astral}":1}`);
    assert.ok(compareCodePoints(bmp, astral) < 0);
    assert.ok([astral, bmp].sort()[0] === astral, "sanity: JS default sort is UTF-16");
  });

  it("D3: integral numbers (1.0, 1e3, -0) are integers; non-integral are rejected", () => {
    assert.equal(canonicalJson({ a: 1.0, b: 1e3, c: -0 }), '{"a":1,"b":1000,"c":0}');
    assert.throws(() => canonicalJson({ x: 1.5 }), /non-integral/);
    assert.throws(() => canonicalJson({ x: Number.NaN }));
    assert.throws(() => canonicalJson({ x: Number.POSITIVE_INFINITY }));
  });

  it("rejects out-of-range int53", () => {
    assert.throws(() => canonicalJson({ x: INT53_MAX + 1 }));
  });

  it("treats undefined object members as absent", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  it("rejects lone surrogates (strings must be well-formed Unicode)", () => {
    assert.equal(toCanonical({ s: "\uD800x" }).ok, false);
    assert.equal(toCanonical({ s: "\u{1F600}" }).ok, true);
  });

  it("toCanonical reports the first non-canonical path", () => {
    const r = toCanonical({ result: { ok: 1, score: 0.8, list: [1, 2.5] } }, "$");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.path, "$.result.list[1]");
  });

  it("hashes stably", () => {
    const h1 = stateHash({ fan_percent: 0, sensor_healthy: 1 });
    const h2 = stateHash({ sensor_healthy: 1, fan_percent: 0 });
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it("deepEq ignores key insertion order and is false for non-canonical values", () => {
    assert.equal(deepEq({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
    assert.equal(deepEq({ a: 0.5 }, { a: 0.5 }), false);
  });
});

describe("code point lengths (D2, spec-v0.3 §1.4)", () => {
  it("counts code points, not UTF-16 units", () => {
    assert.equal(cpLength("a\u{1F600}b"), 3);
    assert.equal(buildMessageSnapshot("a\u{1F600}b").length, 3);
  });

  it("excerpt truncates by code points with a marker", () => {
    assert.equal(excerpt("abc", 3), "abc");
    assert.equal(excerpt("\u{1F600}\u{1F600}\u{1F600}", 2), `\u{1F600}\u{1F600}${TRUNCATION_SUFFIX}`);
    // Never splits a surrogate pair.
    assert.equal(toCanonical(excerpt("\u{1F600}".repeat(10), 3)).ok, true);
  });
});

describe("predicates", () => {
  const snap: Snapshot = {
    action: { name: "actuator.fan.set", args: { percent: 40 } },
    state: { sensor_healthy: 1, fan_percent: 0 },
    observation: { percent: 40 },
  };
  it("eq / lte / eq_path", () => {
    assert.equal(evalPredicate({ path: "action.args.percent", lte: 80 }, snap), true);
    assert.equal(evalPredicate({ path: "action.args.percent", gt: 80 }, snap), false);
    assert.equal(
      evalPredicate({ path: "observation.percent", eq_path: "action.args.percent" }, snap),
      true,
    );
  });
  it("all / any / not", () => {
    assert.equal(
      evalPredicate(
        {
          all: [
            { path: "state.sensor_healthy", eq: 1 },
            { path: "action.name", eq: "actuator.fan.set" },
          ],
        },
        snap,
      ),
      true,
    );
    assert.equal(evalPredicate({ not: { path: "state.sensor_healthy", eq: 0 } }, snap), true);
  });
  it("MISSING sentinel", () => {
    assert.equal(isMissing(getPath(snap, "action.args.missing")), true);
    assert.equal(getPath(snap, "action.args.percent"), 40);
    assert.equal(evalPredicate({ path: "action.args.missing", eq: 1 }, snap), false);
    assert.equal(evalPredicate({ path: "action.args.missing", neq: 1 }, snap), false);
    assert.equal(
      evalPredicate({ path: "action.args.a", eq_path: "action.args.b" }, snap),
      true,
    );
    assert.equal(evalPredicate({ not: { path: "action.args.missing", eq: 1 } }, snap), true);
  });
  it("null is not MISSING", () => {
    const s: Snapshot = { state: { x: null } };
    assert.equal(isMissing(getPath(s, "state.x")), false);
    assert.equal(evalPredicate({ path: "state.x", eq: null }, s), true);
  });

  it("D16: inherited members never resolve", () => {
    const s: Snapshot = { state: { a: 1 } };
    assert.equal(getPath(s, "state.constructor"), MISSING);
    assert.equal(getPath(s, "state.toString"), MISSING);
    assert.equal(getPath(s, "state.__proto__"), MISSING);
    // Before D16, `state.constructor` resolved to Object and `neq 1` was true.
    assert.equal(evalPredicate({ path: "state.constructor", neq: 1 }, s), false);
  });

  it("D16: arrays and strings have no members (no .length, no index)", () => {
    const s: Snapshot = { state: { xs: [5, 6], name: "abc" } };
    assert.equal(getPath(s, "state.xs.length"), MISSING);
    assert.equal(getPath(s, "state.xs.0"), MISSING);
    assert.equal(getPath(s, "state.name.length"), MISSING);
    assert.equal(evalPredicate({ path: "state.xs.length", gte: 1 }, s), false);
    assert.equal(evalPredicate({ not: { path: "state.xs.length", gte: 1 } }, s), true);
  });

  it("numeric comparisons require integers", () => {
    const s: Snapshot = { state: { b: true, s: "5" } };
    assert.equal(evalPredicate({ path: "state.b", gte: 0 }, s), false);
    assert.equal(evalPredicate({ path: "state.s", gte: 0 }, s), false);
  });
});
