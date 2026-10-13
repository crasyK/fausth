/** Repetitions must be detectable as non-independent (gateway cache / determinism). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractCompletionIds,
  independenceReport,
  trajectoryFingerprint,
} from "./lib/independence.mjs";

const ev = (...lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("independence", () => {
  it("fingerprints the proposal sequence, ignoring key order", () => {
    const a = ev(
      { stage: "propose", tool: "fs.read", args: { path: "a", n: 1 } },
      { stage: "execute", tool: "fs.read", result: { t: 1 } },
    );
    const b = ev(
      { stage: "propose", tool: "fs.read", args: { n: 1, path: "a" } },
      { stage: "execute", tool: "fs.read", result: { t: 2 } },
    );
    assert.equal(trajectoryFingerprint(a), trajectoryFingerprint(b));
    assert.notEqual(trajectoryFingerprint(a), trajectoryFingerprint(ev({ stage: "propose", tool: "fs.list" })));
    assert.equal(trajectoryFingerprint(ev({ stage: "orient" })), null);
  });

  it("extracts completion ids from report or events", () => {
    assert.deepEqual(
      extractCompletionIds({
        report: { completion_ids: ["c1"], completions: [{ id: "c2" }] },
        eventsText: ev({ stage: "propose", completion_id: "c3" }, { transport: { completion_id: "c1" } }),
      }),
      ["c1", "c2", "c3"],
    );
  });

  it("flags duplicate trajectories and completion ids across reps", () => {
    const row = (rep, sha, ids) => ({
      attempt_id: `t__cb__kit__m__rep${rep}`,
      status: "scored",
      task_id: "t",
      condition: "cb",
      model_id: "kit.glm-5.3-flash",
      deployment_id: "kit",
      rep,
      trajectory_sha256: sha,
      completion_ids: ids,
    });
    const r = independenceReport([row(1, "x", ["c1"]), row(2, "x", ["c1"]), row(3, "y", ["c9"])], {
      mode: "live",
    });
    assert.equal(r.ok, false);
    assert.equal(r.duplicate_trajectories.length, 1);
    assert.deepEqual(r.duplicate_trajectories[0].attempts.length, 2);
    assert.deepEqual(r.duplicate_completion_ids[0].completion_id, "c1");
    assert.equal(independenceReport([row(1, "x", []), row(2, "y", [])]).ok, true);
  });
});
