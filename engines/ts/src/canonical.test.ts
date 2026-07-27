import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, deepEq, stateHash } from "./canonical.js";
import { evalPredicate, getPath, MISSING, isMissing } from "./predicates.js";
import type { Snapshot } from "./types.js";
import { INT53_MAX } from "./types.js";

describe("canonicalJson", () => {
  it("sorts keys", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });
  it("rejects floats", () => {
    assert.throws(() => canonicalJson({ x: 1.5 }));
  });
  it("rejects out-of-range int53", () => {
    assert.throws(() => canonicalJson({ x: INT53_MAX + 1 }));
  });
  it("hashes stably", () => {
    const h1 = stateHash({ fan_percent: 0, sensor_healthy: 1 });
    const h2 = stateHash({ sensor_healthy: 1, fan_percent: 0 });
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });
  it("deepEq ignores key insertion order", () => {
    assert.equal(deepEq({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
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
});
