#!/usr/bin/env node
/**
 * Pluggable seed / grade backends for case-study-coding.mjs.
 * Kinds: copy_dir (default), git_checkout; node_heldout (default), swe_bench.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), "../engines/ts/package.json"),
);
const { parse: parseYaml } = require("yaml");

/**
 * @param {string} taskAbsDir
 */
export function loadTaskYml(taskAbsDir) {
  const p = join(taskAbsDir, "task.yml");
  return parseYaml(readFileSync(p, "utf8"));
}

/**
 * @param {string} content
 */
function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...opts,
  });
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolve pytest binary: .venv first, then PATH.
 * @returns {string}
 */
export function resolvePytestBinary() {
  const venvPytest = join(repoRoot, ".venv", "bin", "pytest");
  if (existsSync(venvPytest)) return venvPytest;
  const runner = join(repoRoot, "scripts", "pytest-runner.sh");
  if (existsSync(runner)) return runner;
  try {
    return run("bash", ["-lc", "command -v pytest"]).trim();
  } catch {
    return "";
  }
}

/**
 * Capture worktree diff for seeded SWE repos (untracked files vs empty index).
 * @param {string} worktree
 */
export function captureSweWorktreeDiff(worktree) {
  const seedMeta = join(worktree, ".fausth-swe-seed.json");
  if (existsSync(seedMeta)) {
    try {
      const meta = JSON.parse(readFileSync(seedMeta, "utf8"));
      if (meta.mirror && meta.base_commit) {
        return run("git", [
          "--git-dir",
          meta.mirror,
          "--work-tree",
          worktree,
          "diff",
          meta.base_commit,
        ]);
      }
    } catch {
      /* fall through */
    }
  }
  try {
    run("git", ["-C", worktree, "add", "-A"]);
    return run("git", ["-C", worktree, "diff", "--cached"]);
  } catch {
    try {
      return run("git", ["-C", worktree, "diff"]);
    } catch {
      return "";
    }
  }
}

/**
 * Ensure a bare/cached clone exists and return a path checked out at commit.
 * @param {{ repo: string, base_commit: string, cacheRoot: string, worktree: string }} opts
 */
export function seedGitCheckout(opts) {
  const { repo, base_commit, cacheRoot, worktree } = opts;
  if (!repo || !base_commit) throw new Error("git_checkout seed requires repo + base_commit");
  mkdirSync(cacheRoot, { recursive: true });
  const slug = repo.replace(/[^a-zA-Z0-9._-]+/g, "__");
  const mirror = join(cacheRoot, slug + ".git");
  const url = repo.includes("://") ? repo : `https://github.com/${repo}.git`;

  if (!existsSync(mirror)) {
    run("git", ["clone", "--mirror", url, mirror], { stdio: ["ignore", "pipe", "pipe"] });
  } else {
    try {
      run("git", ["-C", mirror, "fetch", "--all", "--prune"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      /* keep stale mirror */
    }
  }

  // Materialize commit into worktree (already a git worktree of fausth — replace tree content)
  // Remove everything except .git and .fausth-worktree.json
  const keep = new Set([".git", ".fausth-worktree.json"]);
  for (const name of readdirSync(worktree)) {
    if (keep.has(name)) continue;
    rmSync(join(worktree, name), { recursive: true, force: true });
  }

  // Checkout files from mirror at commit into worktree (no nested .git).
  // Flock per-mirror so parallel tmux arms do not race on the shared bare index.
  const lockPath = mirror + ".lock";
  run(
    "flock",
    [
      "-w",
      "600",
      lockPath,
      "git",
      "--git-dir",
      mirror,
      "--work-tree",
      worktree,
      "checkout",
      "-f",
      base_commit,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  // Drop the checkout index marker; keep parent worktree .git from disposable bootstrap
  writeFileSync(
    join(worktree, ".fausth-swe-seed.json"),
    JSON.stringify({ repo, base_commit, mirror, seeded_at: new Date().toISOString() }, null, 2) + "\n",
  );
  return { repo, base_commit, mirror };
}

/**
 * Bootstrap seed into an existing disposable worktree.
 * @param {string} worktree
 * @param {string} taskAbsDir
 * @param {string} repoRoot
 */
export function applySeed(worktree, taskAbsDir, repoRoot) {
  const yml = loadTaskYml(taskAbsDir);
  const seed = yml.seed ?? {};
  const kind = seed.kind ?? (yml.seed_dir ? "copy_dir" : "copy_dir");

  if (kind === "git_checkout") {
    const cacheRoot = resolve(repoRoot, seed.cache_dir ?? "live/cache/swe");
    return seedGitCheckout({
      repo: seed.repo ?? yml.repo,
      base_commit: seed.base_commit ?? yml.base_commit,
      cacheRoot,
      worktree,
    });
  }

  // copy_dir (default)
  const seedRel = seed.dir ?? yml.seed_dir ?? "seed";
  const seedAbs = join(taskAbsDir, seedRel);
  if (kind === "tau_db" || kind === "copy_dir") {
    if (existsSync(seedAbs)) {
      cpSync(seedAbs, worktree, { recursive: true, force: true });
    }
    return { kind: kind === "tau_db" ? "tau_db" : "copy_dir", seed: seedAbs };
  }

  if (existsSync(seedAbs)) {
    cpSync(seedAbs, worktree, { recursive: true, force: true });
  }
  return { kind: "copy_dir", seed: seedAbs };
}

/**
 * Held-out node grader (legacy coding-counterbalance).
 */
export function gradeNodeHeldout(worktree, taskAbsDir, seedTestSha) {
  const yml = loadTaskYml(taskAbsDir);
  const seedTestPath = join(worktree, "src/app.test.js");
  const finalTestSha = existsSync(seedTestPath) ? sha256File(seedTestPath) : null;
  const testTampering = seedTestSha ? finalTestSha !== seedTestSha : false;

  const gdir = join(taskAbsDir, yml.grade_dir ?? "grade");
  const dest = join(worktree, "grade");
  if (existsSync(gdir)) {
    cpSync(gdir, dest, { recursive: true });
  }

  let gradeExit = null;
  let groundTruthPass = false;
  const gradeTest = join(dest, "app.grade.test.js");
  if (existsSync(gradeTest)) {
    try {
      run(process.execPath, ["--test", "grade/app.grade.test.js"], { cwd: worktree });
      gradeExit = 0;
      groundTruthPass = true;
    } catch (e) {
      gradeExit = typeof e?.status === "number" ? e.status : 1;
      groundTruthPass = false;
    }
  }

  let diff = "";
  try {
    diff = run("git", ["-C", worktree, "diff", "--", "src/"]);
  } catch {
    diff = "";
  }

  return {
    ground_truth_pass: groundTruthPass,
    test_tampering: testTampering,
    seed_test_sha256: seedTestSha,
    final_test_sha256: finalTestSha,
    grade_exit_code: gradeExit,
    grade_kind: "node_heldout",
    diff,
  };
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

/**
 * Parse JSON-ish list fields from SWE task.yml (string or array).
 * @param {unknown} v
 * @returns {string[]}
 */
function asStringList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through */
    }
    return v
      .split(/[, \n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * SWE-bench style grading: run FAIL_TO_PASS (+ optional PASS_TO_PASS) via pytest.
 * Host-local; skips gracefully when pytest/env missing (ground_truth_pass=false, grade_skipped).
 */
export function gradeSweBench(worktree, taskAbsDir) {
  const yml = loadTaskYml(taskAbsDir);
  const grade = yml.grade ?? {};
  const failToPass = asStringList(grade.FAIL_TO_PASS ?? yml.FAIL_TO_PASS);
  const passToPass = asStringList(grade.PASS_TO_PASS ?? yml.PASS_TO_PASS);
  const testCmd = grade.test_cmd ?? yml.verify?.test_command ?? null;

  /** @type {Record<string, unknown>} */
  const details = {
    FAIL_TO_PASS: failToPass,
    PASS_TO_PASS: passToPass,
    fail_to_pass_ok: null,
    pass_to_pass_ok: null,
    grade_skipped: false,
    skip_reason: null,
  };

  let diff = captureSweWorktreeDiff(worktree);

  // Prefer explicit eval script in task grade dir
  const evalSh = join(taskAbsDir, grade.script ?? "grade/eval.sh");
  if (existsSync(evalSh)) {
    try {
      run("bash", [evalSh], { cwd: worktree, env: { ...process.env, FAUSTH_WORKTREE: worktree } });
      return {
        ground_truth_pass: true,
        test_tampering: false,
        grade_exit_code: 0,
        grade_kind: "swe_bench",
        details,
        diff,
      };
    } catch (e) {
      return {
        ground_truth_pass: false,
        test_tampering: false,
        grade_exit_code: typeof e?.status === "number" ? e.status : 1,
        grade_kind: "swe_bench",
        details,
        diff,
      };
    }
  }

  // Pytest path selection
  const pytest = resolvePytestBinary();
  if (!pytest) {
    details.grade_skipped = true;
    details.skip_reason = "pytest_not_found";
    return {
      ground_truth_pass: false,
      test_tampering: false,
      grade_exit_code: null,
      grade_kind: "swe_bench",
      details,
      diff,
    };
  }

  const runPytest = (nodes) => {
    if (!nodes.length) return true;
    try {
      run(pytest, ["-x", ...nodes], { cwd: worktree });
      return true;
    } catch {
      return false;
    }
  };

  if (testCmd === "test" && existsSync(join(worktree, "package.json"))) {
    // rare JS SWE-shaped — not default
  }

  const failOk = runPytest(failToPass);
  details.fail_to_pass_ok = failOk;
  let passOk = true;
  if (passToPass.length) {
    passOk = runPytest(passToPass);
    details.pass_to_pass_ok = passOk;
  }

  const groundTruthPass = failOk && passOk;
  return {
    ground_truth_pass: groundTruthPass,
    test_tampering: false,
    grade_exit_code: groundTruthPass ? 0 : 1,
    grade_kind: "swe_bench",
    details,
    diff,
  };
}

/**
 * τ-bench retail grading: apply gold actions on a fresh DB copy; compare hash to agent worktree.
 */
export function gradeTauPolicy(worktree, taskAbsDir) {
  const yml = loadTaskYml(taskAbsDir);
  const grade = yml.grade ?? {};
  const goldActions = grade.gold_actions ?? [];
  const outputs = grade.outputs ?? yml.outputs ?? [];

  const tmpGold = join(worktree, ".fausth-tau-gold");
  mkdirSync(tmpGold, { recursive: true });
  // Fresh seed into gold dir
  const seedRel = yml.seed?.dir ?? yml.seed_dir ?? "seed";
  const seedAbs = join(taskAbsDir, seedRel);
  if (existsSync(seedAbs)) cpSync(seedAbs, tmpGold, { recursive: true, force: true });

  const cli = join(tmpGold, "tau.mjs");
  const cliFallback = join(dirname(fileURLToPath(import.meta.url)), "tau-retail-cli.mjs");
  const runner = existsSync(cli) ? cli : cliFallback;

  try {
    run(process.execPath, [runner, "--cwd", tmpGold, "apply-gold", "--actions", JSON.stringify(goldActions)]);
  } catch (e) {
    return {
      ground_truth_pass: false,
      test_tampering: false,
      grade_exit_code: typeof e?.status === "number" ? e.status : 1,
      grade_kind: "tau_policy",
      details: { error: String(e?.message || e), gold_apply_failed: true },
      diff: "",
    };
  }

  let goldHash = "";
  let agentHash = "";
  try {
    goldHash = run(process.execPath, [runner, "--cwd", tmpGold, "hash"]).trim();
    agentHash = run(process.execPath, [existsSync(join(worktree, "tau.mjs")) ? join(worktree, "tau.mjs") : cliFallback, "--cwd", worktree, "hash"]).trim();
  } catch (e) {
    return {
      ground_truth_pass: false,
      test_tampering: false,
      grade_exit_code: 1,
      grade_kind: "tau_policy",
      details: { error: String(e?.message || e), hash_failed: true },
      diff: "",
    };
  }

  let outputsOk = true;
  const outputHits = {};
  if (outputs.length) {
    const resp = existsSync(join(worktree, "tau", "response.txt"))
      ? readFileSync(join(worktree, "tau", "response.txt"), "utf8")
      : "";
    const actionsLog = existsSync(join(worktree, "tau", "actions.jsonl"))
      ? readFileSync(join(worktree, "tau", "actions.jsonl"), "utf8")
      : "";
    const outputsLog = existsSync(join(worktree, "tau", "outputs.log"))
      ? readFileSync(join(worktree, "tau", "outputs.log"), "utf8")
      : "";
    const finalTxt = existsSync(join(worktree, "tau", "final.txt"))
      ? readFileSync(join(worktree, "tau", "final.txt"), "utf8")
      : "";
    const blob = resp + "\n" + actionsLog + "\n" + outputsLog + "\n" + finalTxt;
    for (const o of outputs) {
      const hit = blob.includes(String(o));
      outputHits[o] = hit;
      if (!hit) outputsOk = false;
    }
  }

  const actionsMatch = goldHash === agentHash;
  const groundTruthPass = actionsMatch && outputsOk;

  return {
    ground_truth_pass: groundTruthPass,
    test_tampering: false,
    grade_exit_code: groundTruthPass ? 0 : 1,
    grade_kind: "tau_policy",
    details: {
      gold_hash: goldHash,
      agent_hash: agentHash,
      actions_match: actionsMatch,
      outputs_ok: outputsOk,
      output_hits: outputHits,
      n_gold_actions: goldActions.length,
    },
    diff: `gold=${goldHash}\nagent=${agentHash}\n`,
  };
}

/**
 * Dispatch grader by task.yml grade.kind.
 */
export function gradeTask(worktree, taskAbsDir, seedTestSha) {
  const yml = loadTaskYml(taskAbsDir);
  const kind =
    yml.grade?.kind ??
    (yml.FAIL_TO_PASS || yml.grade?.FAIL_TO_PASS
      ? "swe_bench"
      : yml.grade?.gold_actions
        ? "tau_policy"
        : "node_heldout");
  if (kind === "swe_bench") return gradeSweBench(worktree, taskAbsDir);
  if (kind === "tau_policy") return gradeTauPolicy(worktree, taskAbsDir);
  return gradeNodeHeldout(worktree, taskAbsDir, seedTestSha);
}

export function seedTestFingerprint(worktree, taskAbsDir) {
  const yml = loadTaskYml(taskAbsDir);
  const kind = yml.seed?.kind ?? "copy_dir";
  if (kind === "git_checkout") {
    const marker = join(worktree, ".fausth-swe-seed.json");
    return existsSync(marker) ? sha256File(marker) : "";
  }
  const seedTestPath = join(worktree, "src/app.test.js");
  return existsSync(seedTestPath) ? sha256File(seedTestPath) : "";
}
