/** CASE-13: results/ only receives explicitly promoted, verified evidence runs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseArgs, promote } from "./promote-run.mjs";

function makeRun(dir, name, { mode = "live", evidence = true, invariantsOk = true, complete = true } = {}) {
  const runDir = join(dir, "raw", name);
  mkdirSync(runDir, { recursive: true });
  const summary = {
    provenance: {
      run_id: name,
      mode,
      evidence,
      evidence_reason: evidence ? "live run on a clean tree" : "dirty working tree (allowed by --allow-dirty)",
      manifest_path: join(dir, "manifest.yml"),
      code_state: { commit_sha: "a".repeat(40), dirty: !evidence, diff_sha256: null },
    },
    invariants: { ok: invariantsOk, violations: invariantsOk ? [] : ["x"] },
    accounting: { complete },
    aggregates: {},
  };
  const body = JSON.stringify(summary, null, 2) + "\n";
  writeFileSync(join(runDir, "summary.json"), body);
  writeFileSync(
    join(runDir, "summary.sha256"),
    createHash("sha256").update(body).digest("hex") + "  summary.json\n",
  );
  return runDir;
}

describe("promote-run", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fausth-promote-"));
    writeFileSync(
      join(dir, "manifest.yml"),
      `study_id: s\noutputs:\n  raw_dir: ${join(dir, "raw")}\n  summary: ${join(dir, "results", "summary.json")}\n`,
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("copies a verified evidence run with a provenance record", () => {
    const run = makeRun(dir, "live-ok");
    const r = promote(parseArgs(["--run", run]));
    assert.equal(r.summaryPath, join(dir, "results", "live-ok.summary.json"));
    assert.equal(readFileSync(r.summaryPath, "utf8"), readFileSync(join(run, "summary.json"), "utf8"));
    const rec = JSON.parse(readFileSync(r.recordPath, "utf8"));
    assert.equal(rec.evidence, true);
    assert.deepEqual(rec.overrides, []);
    assert.throws(() => promote(parseArgs(["--run", run])), /not overwritten/);
    assert.deepEqual(promote(parseArgs(["--run", run, "--force"])).record.overrides, ["force_overwrite"]);
  });

  it("never promotes recorded runs", () => {
    const run = makeRun(dir, "rec", { mode: "recorded", evidence: false });
    assert.throws(() => promote(parseArgs(["--run", run, "--allow-non-evidence"])), /recorded/);
    assert.ok(!existsSync(join(dir, "results", "rec.summary.json")));
  });

  it("requires explicit overrides for non-evidence or failed checks and records them", () => {
    const dirty = makeRun(dir, "dirty", { evidence: false });
    assert.throws(() => promote(parseArgs(["--run", dirty])), /non-evidence/);
    const r = promote(parseArgs(["--run", dirty, "--allow-non-evidence"]));
    assert.equal(r.record.evidence, false);
    assert.deepEqual(r.record.overrides, ["allow_non_evidence"]);
    const bad = makeRun(dir, "bad", { invariantsOk: false });
    assert.throws(() => promote(parseArgs(["--run", bad])), /invariants failed/);
    const partial = makeRun(dir, "partial", { complete: false });
    assert.throws(() => promote(parseArgs(["--run", partial])), /not fully accounted/);
  });

  it("refuses summaries modified after the run", () => {
    const run = makeRun(dir, "tampered");
    writeFileSync(join(run, "summary.json"), "{}\n");
    assert.throws(() => promote(parseArgs(["--run", run])), /does not match/);
  });
});
