/**
 * Runner integration tests in recorded mode (no model calls).
 *
 * SCR-8   adaptive chains that succeed early exit 0 with skipped tries accounted
 * SCR-6   summaries aggregate per (task, rep) unit
 * SCR-10  train-freeze-eval freezes one harness per (model, rep) lineage
 * CASE-13 runs never write into case-study results/
 * CASE-14 provenance records code state, runtime and input hashes
 * D15     retired KIT ids fail fast
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, resolveFrozenHarnessDir, resolveRawRoot } from "./case-study-coding.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "scripts/case-study-coding.mjs");
const CB_TRACE = join(root, "case-studies/coding-counterbalance/recorded/01-fix-add/counterbalanced.model.jsonl");

/** Write a temporary study (manifest + recorded traces) outside the repository. */
function makeStudy(dir, { harnesses, conditions, traces, matrix = {}, tasks = ["01-fix-add"] }) {
  const lines = [
    "study_id: runner-integration-test",
    "harnesses:",
    ...Object.entries(harnesses).map(([k, p]) => `  ${k}: { kind: single, path: ${p} }`),
    "deployments:",
    "  recorded:",
    "    id: recorded",
    "    path: case-studies/coding-counterbalance/deployments/local-recorded.yml",
    "    model_id: recorded-fixture",
    "    api_key_env: null",
    "  kit:",
    "    id: kit",
    "    path: case-studies/coding-counterbalance/deployments/local-kit.yml",
    "    model_id: kit.glm-5.3-flash",
    "    api_key_env: KIT_AI_API_KEY",
    "matrix:",
    "  repetitions: 1",
    "  max_steps: 30",
    `  conditions: [${conditions.join(", ")}]`,
    "  live_deployments: [kit]",
    "  recorded_provider_labels: [kit]",
    ...Object.entries(matrix).map(([k, v]) => `  ${k}: ${v}`),
    "tasks:",
    ...tasks.map(
      (t) => `  - { id: ${t}, category: bugfix, path: case-studies/coding-counterbalance/tasks/${t} }`,
    ),
    "outputs:",
    `  raw_dir: ${join(dir, "raw")}`,
    `  summary: ${join(dir, "results", "summary.json")}`,
  ];
  writeFileSync(join(dir, "manifest.yml"), lines.join("\n") + "\n");
  for (const t of tasks) {
    mkdirSync(join(dir, "recorded", t), { recursive: true });
    for (const c of traces) copyFileSync(CB_TRACE, join(dir, "recorded", t, `${c}.model.jsonl`));
  }
  return join(dir, "manifest.yml");
}

function runRunner(args, env = {}) {
  const r = spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return r;
}

describe("case-study runner (recorded)", { timeout: 600_000 }, () => {
  let tmp = "";
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "fausth-runner-"));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("accounts tries skipped after success and exits 0 (SCR-8, SCR-6, CASE-13, CASE-14)", () => {
    const dir = join(tmp, "adaptive");
    mkdirSync(dir, { recursive: true });
    const manifest = makeStudy(dir, {
      harnesses: {
        "cb-mutable": "examples/coding-counterbalance",
        counterbalanced: "examples/coding-counterbalance",
      },
      conditions: ["cb-mutable", "counterbalanced"],
      traces: ["cb-mutable", "counterbalanced"],
      matrix: { max_task_tries: 3 },
    });
    const r = runRunner(["--manifest", manifest, "--mode", "recorded", "--skip-conformance", "--run-id", "t1"]);
    assert.equal(r.status, 0, r.stderr.slice(-3000));
    const rawRoot = join(dir, "raw", "t1");
    const ledger = JSON.parse(readFileSync(join(rawRoot, "ledger.json"), "utf8"));
    const chain = ledger.attempts.filter((a) => a.condition === "cb-mutable");
    assert.deepEqual(
      chain.map((a) => [a.try_index, a.status]),
      [
        [1, "scored"],
        [2, "skipped_after_success"],
        [3, "skipped_after_success"],
      ],
    );
    const summary = JSON.parse(readFileSync(join(rawRoot, "summary.json"), "utf8"));
    assert.equal(summary.accounting.complete, true);
    assert.equal(summary.invariants.ok, true, JSON.stringify(summary.invariants));
    assert.equal(summary.aggregates.by_condition["cb-mutable"].n, 1, "one unit per chain");
    assert.equal(summary.aggregates.paired_deltas.task_success.status, "ok");
    assert.equal(summary.aggregates.paired_deltas.task_success.n_matched, 1);
    // CASE-13: nothing written to the results/ location.
    assert.ok(!existsSync(join(dir, "results")), "runner must not write into results/");
    // CASE-14: provenance.
    const p = summary.provenance;
    assert.equal(p.evidence, false);
    assert.match(String(p.code_state.commit_sha), /^[0-9a-f]{40}$/);
    assert.equal(typeof p.code_state.dirty, "boolean");
    assert.equal(p.runtime.node, process.version);
    for (const f of [
      "examples/coding-counterbalance/agent.yml",
      "case-studies/coding-counterbalance/tasks/01-fix-add/task.yml",
      "case-studies/coding-counterbalance/tasks/01-fix-add/grade/app.grade.test.js",
      "case-studies/coding-counterbalance/deployments/local-recorded.yml",
      "scripts/case-study-coding.mjs",
      "scripts/case-study-backends.mjs",
    ]) {
      assert.match(String(p.input_files[f]), /^[0-9a-f]{64}$/, f);
    }
    assert.match(String(p.engine_tree_hashes["engines/ts/src"]), /^[0-9a-f]{64}$/);
    // Workspaces are isolated: no task.yml was visible (provenance records the workspace id).
    assert.ok(chain[0].workspace?.id?.startsWith("ws-"));
    // Resume is a no-op and still exits 0 (inputs unchanged).
    const again = runRunner([
      "--manifest",
      manifest,
      "--mode",
      "recorded",
      "--skip-conformance",
      "--run-id",
      "t1",
      "--resume",
    ]);
    assert.equal(again.status, 0, again.stderr.slice(-2000));
  });

  it("freezes one harness per (model, rep) lineage under --train-freeze-eval (SCR-10)", () => {
    const dir = join(tmp, "freeze");
    mkdirSync(dir, { recursive: true });
    const manifest = makeStudy(dir, {
      harnesses: {
        "mutable-skills": "examples/coding-counterbalance",
        baseline: "examples/coding-counterbalance",
      },
      conditions: ["baseline", "mutable-skills"],
      traces: ["mutable-skills", "frozen-mutable", "baseline"],
    });
    const r = runRunner([
      "--manifest",
      manifest,
      "--mode",
      "recorded",
      "--skip-conformance",
      "--train-freeze-eval",
      "--train-passes",
      "1",
      "--reps",
      "2",
      "--run-id",
      "tfe",
    ]);
    assert.equal(r.status, 0, r.stderr.slice(-3000));
    const rawRoot = join(dir, "raw", "tfe");
    const frozenRoots = ["rep1", "rep2"].map((rep) =>
      join(rawRoot, "lineage", "frozen", `mutable-skills__${rep}__recorded-kit__kit`),
    );
    for (const fr of frozenRoots) {
      assert.ok(existsSync(join(fr, "single", "agent.json")), fr);
      const meta = JSON.parse(readFileSync(join(fr, "frozen.json"), "utf8"));
      assert.equal(meta.phases.single.source, "stock_never_patched");
    }
    const ledger = JSON.parse(readFileSync(join(rawRoot, "ledger.json"), "utf8"));
    const frozenEval = ledger.attempts.filter((a) => a.condition === "frozen-mutable");
    assert.equal(frozenEval.length, 2);
    for (const a of frozenEval) {
      const report = JSON.parse(readFileSync(a.artifacts.report, "utf8"));
      assert.match(report.phases[0].harness_dir, new RegExp(`mutable-skills__rep${a.rep}__`));
    }
    assert.throws(
      () => resolveFrozenHarnessDir(rawRoot, "mutable-skills__rep3__recorded-kit__kit", "single"),
      /frozen harness missing/,
    );
  });

  it("fails fast on retired KIT model ids (D15)", () => {
    const dir = join(tmp, "retired");
    mkdirSync(dir, { recursive: true });
    const manifest = makeStudy(dir, {
      harnesses: { counterbalanced: "examples/coding-counterbalance" },
      conditions: ["counterbalanced"],
      traces: ["counterbalanced"],
    });
    const r = runRunner(
      ["--manifest", manifest, "--mode", "live", "--kit-models", "kit.gemma4-31b-it", "--skip-conformance"],
      { KIT_AI_API_KEY: "" },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /retired KIT model/);
    assert.ok(!existsSync(join(dir, "raw")), "nothing ran");
  });
});

describe("runner argument / output guards", () => {
  it("rejects unknown flags and writes never into results/", () => {
    assert.throws(() => parseArgs(["--rep", "2"]), /unknown flag/);
    assert.throws(() => resolveRawRoot("case-studies/x/results", "r1"), /must not point into/);
    assert.throws(() => resolveRawRoot("live/reports/x", "../evil"), /invalid --run-id/);
    assert.match(resolveRawRoot("live/reports/x", "r1"), /live\/reports\/x\/r1$/);
  });
});
