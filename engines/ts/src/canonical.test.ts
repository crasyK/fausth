import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, stateHash } from "./canonical.js";
import { evalPredicate } from "./predicates.js";
import type { Snapshot } from "./types.js";

describe("canonicalJson", () => {
  it("sorts keys", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });
  it("rejects floats", () => {
    assert.throws(() => canonicalJson({ x: 1.5 }));
  });
  it("hashes stably", () => {
    const h1 = stateHash({ fan_percent: 0, sensor_healthy: 1 });
    const h2 = stateHash({ sensor_healthy: 1, fan_percent: 0 });
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
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
});
