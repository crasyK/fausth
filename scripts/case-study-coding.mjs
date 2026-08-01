#!/usr/bin/env node
/**
 * Coding Counterbalance case-study runner.
 *
 * Usage:
 *   node scripts/case-study-coding.mjs --mode recorded
 *   node scripts/case-study-coding.mjs --mode live
 *   node scripts/case-study-coding.mjs --mode live --resume
 *   node scripts/case-study-coding.mjs --mode recorded --limit 4
 *   node scripts/case-study-coding.mjs --mode live --kit-models all --run-id live-kit-all-v1
 *   node scripts/case-study-coding.mjs --manifest case-studies/mutable-cells/manifest.yml \
 *     --mode live --curriculum --reps 1 --run-id live-kit-mutable-curriculum-v1
 *   node scripts/case-study-coding.mjs --manifest case-studies/mutable-cells/manifest.yml \
 *     --mode live --train-freeze-eval --train-passes 2 --shuffle-curriculum \
 *     --kit-models kit.minimax-m2.7-229b --run-id live-kit-mutable-train-freeze-minimax-v1
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateAttempts, parseEventsJsonl, scoreAttempt } from "./case-study-score.mjs";
import {
  phaseYielded,
  shouldStartImplementation,
} from "./case-study-pipeline.mjs";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../engines/ts/package.json"));
const { parse: parseYaml } = require("yaml");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Pinned KIT catalog (see examples/coding-counterbalance/deployment.kit.yml). */
const ALL_KIT_MODELS = [
  "kit.minimax-m2.7-229b",
  "kit.mistral-small-4-119b-a8b",
  "kit.qwen3.5-397b-A17b",
  "kit.gemma4-31b-it",
];

const DEFAULT_LIVE_KIT_MODELS = ["kit.gemma4-31b-it", "kit.minimax-m2.7-229b"];

function loadDotEnv(path = join(root, ".env")) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs(argv) {
  const out = {
    mode: "recorded",
    resume: false,
    limit: null,
    skipConformance: false,
    kitModels: null,
    taskIds: null,
    reps: null,
    curriculum: false,
    trainFreezeEval: false,
    trainPasses: 2,
    shuffleCurriculum: false,
    curriculumShuffleSeed: 71,
    conditions: null,
    manifest: "case-studies/coding-counterbalance/manifest.yml",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") out.mode = argv[++i] ?? "recorded";
    else if (a === "--resume") out.resume = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--skip-conformance") out.skipConformance = true;
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--reps") out.reps = Number(argv[++i]);
    else if (a === "--curriculum") out.curriculum = true;
    else if (a === "--train-freeze-eval") out.trainFreezeEval = true;
    else if (a === "--train-passes") out.trainPasses = Number(argv[++i]);
    else if (a === "--shuffle-curriculum") out.shuffleCurriculum = true;
    else if (a === "--curriculum-shuffle-seed") {
      out.curriculumShuffleSeed = Number(argv[++i]);
    } else if (a === "--conditions") {
      out.conditions = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--tasks") {
      out.taskIds = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--kit-models") {
      const raw = argv[++i] ?? "";
      out.kitModels =
        raw === "all"
          ? [...ALL_KIT_MODELS]
          : raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (out.mode !== "recorded" && out.mode !== "live") {
    throw new Error(`--mode must be recorded|live (got ${out.mode})`);
  }
  if (out.kitModels != null && out.mode !== "live") {
    throw new Error("--kit-models requires --mode live");
  }
  if (out.reps != null && (!Number.isFinite(out.reps) || out.reps < 1)) {
    throw new Error(`--reps must be a positive integer (got ${out.reps})`);
  }
  if (
    out.trainPasses != null &&
    (!Number.isFinite(out.trainPasses) || out.trainPasses < 1)
  ) {
    throw new Error(`--train-passes must be a positive integer (got ${out.trainPasses})`);
  }
  if (
    out.curriculumShuffleSeed != null &&
    !Number.isFinite(out.curriculumShuffleSeed)
  ) {
    throw new Error(
      `--curriculum-shuffle-seed must be a number (got ${out.curriculumShuffleSeed})`,
    );
  }
  if (out.trainFreezeEval) {
    out.curriculum = true;
    out.shuffleCurriculum = true;
  }
  return out;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    ...opts,
  });
}

function sha256File(path) {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function gitSha() {
  try {
    return run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  } catch {
    return null;
  }
}

function loadManifest(relPath = "case-studies/coding-counterbalance/manifest.yml") {
  const path = isAbsolute(relPath) ? relPath : join(root, relPath);
  return { path, dir: dirname(path), data: parseYaml(readFileSync(path, "utf8")) };
}

function sanitizeIdPart(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function attemptId(a) {
  const parts = [
    a.task_id,
    a.condition,
    a.deployment_id,
    sanitizeIdPart(a.model_id),
    `rep${a.rep}`,
  ];
  if (a.phase === "train") parts.push(`train_pass${a.train_pass ?? 1}`);
  else if (a.phase === "eval") parts.push("eval");
  return parts.join("__");
}

/** @param {unknown[]} arr @param {number} seed */
function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function resolveTasks(manifest, taskIds) {
  if (!taskIds?.length) return [...manifest.tasks];
  return taskIds.map((id) => {
    const t = manifest.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`unknown --tasks id: ${id}`);
    return t;
  });
}

function resolveRepoPath(p) {
  return isAbsolute(p) ? p : join(root, p);
}

function kitDeploymentPath(modelId, runRoot, kitTemplatePath) {
  const safe = sanitizeIdPart(modelId);
  const dir = join(runRoot, "deployments");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `local-kit__${safe}.yml`);
  if (existsSync(out)) return relative(root, out);

  const basePath = resolveRepoPath(kitTemplatePath);
  const dep = parseYaml(readFileSync(basePath, "utf8"));
  dep.model.models = [modelId];
  writeFileSync(out, stringifyYaml(dep));
  return relative(root, out);
}

function stringifyYaml(obj) {
  const { stringify } = require("yaml");
  return stringify(obj);
}

function buildPlan(manifest, mode, opts = {}) {
  const reps = Number(opts.reps ?? manifest.matrix.repetitions ?? 3);
  const conditions = opts.conditions?.length
    ? opts.conditions
    : manifest.matrix.conditions;
  for (const c of conditions) {
    if (!manifest.harnesses[c] && c !== "frozen-mutable") {
      throw new Error(`unknown condition / harness: ${c}`);
    }
  }
  const plan = [];
  const deployments =
    mode === "live"
      ? manifest.matrix.live_deployments.map((id) => ({
          deployment_id: id,
          ...manifest.deployments[id],
        }))
      : manifest.matrix.recorded_provider_labels.map((label) => ({
          deployment_id: label,
          id: "recorded",
          path: manifest.deployments.recorded.path,
          model_id: `recorded-${label}`,
          api_key_env: null,
        }));

  const kitModels = opts.kitModels;
  const runRoot = opts.runRoot ?? null;
  const kitTemplatePath = manifest.deployments?.kit?.path;
  const tasks = resolveTasks(manifest, opts.taskIds);

  const pushItem = (task, dep, variant, condition, rep, extra = {}) => {
    plan.push({
      task_id: task.id,
      task_path: task.path,
      category: task.category,
      condition,
      deployment_id: dep.deployment_id,
      deployment_path: variant.deployment_path,
      model_id: variant.model_id,
      api_key_env: dep.api_key_env,
      rep,
      ...extra,
    });
  };

  for (const dep of deployments) {
    const modelVariants =
      mode === "live" && dep.deployment_id === "kit" && kitModels?.length
        ? kitModels.map((modelId) => ({
            model_id: modelId,
            deployment_path: runRoot
              ? kitDeploymentPath(modelId, runRoot, kitTemplatePath)
              : dep.path,
          }))
        : [{ model_id: dep.model_id, deployment_path: dep.path }];

    for (const variant of modelVariants) {
      if (opts.trainFreezeEval) {
        const trainPasses = Number(opts.trainPasses ?? 2);
        const shuffleSeed = Number(opts.curriculumShuffleSeed ?? 71);
        for (let rep = 1; rep <= reps; rep++) {
          const order =
            opts.shuffleCurriculum !== false
              ? seededShuffle(tasks, shuffleSeed + rep * 1009)
              : [...tasks];
          for (let pass = 1; pass <= trainPasses; pass++) {
            for (const task of order) {
              pushItem(task, dep, variant, "mutable-skills", rep, {
                phase: "train",
                train_pass: pass,
                curriculum: true,
                task_order: order.map((t) => t.id),
              });
            }
          }
          for (const condition of ["frozen-mutable", "baseline"]) {
            for (const task of order) {
              pushItem(task, dep, variant, condition, rep, {
                phase: "eval",
                curriculum: false,
                mutations_frozen: condition === "frozen-mutable",
                task_order: order.map((t) => t.id),
              });
            }
          }
        }
      } else if (opts.curriculum) {
        for (const condition of conditions) {
          for (let rep = 1; rep <= reps; rep++) {
            const order =
              opts.shuffleCurriculum
                ? seededShuffle(
                    tasks,
                    Number(opts.curriculumShuffleSeed ?? 71) + rep * 1009,
                  )
                : tasks;
            for (const task of order) {
              pushItem(task, dep, variant, condition, rep, { curriculum: true });
            }
          }
        }
      } else {
        for (const task of tasks) {
          for (const condition of conditions) {
            for (let rep = 1; rep <= reps; rep++) {
              pushItem(task, dep, variant, condition, rep, {});
            }
          }
        }
      }
    }
  }
  return plan;
}

function readPrompt(taskPath) {
  const abs = join(root, taskPath);
  const yml = parseYaml(readFileSync(join(abs, "task.yml"), "utf8"));
  return readFileSync(join(abs, yml.prompt_file ?? "prompt.md"), "utf8");
}

function seedDir(taskPath) {
  const abs = join(root, taskPath);
  const yml = parseYaml(readFileSync(join(abs, "task.yml"), "utf8"));
  return join(abs, yml.seed_dir ?? "seed");
}

function gradeDir(taskPath) {
  const abs = join(root, taskPath);
  const yml = parseYaml(readFileSync(join(abs, "task.yml"), "utf8"));
  return join(abs, yml.grade_dir ?? "grade");
}

function harnessSpec(manifest, condition, runMode) {
  const key = condition === "frozen-mutable" ? "mutable-skills" : condition;
  const h = manifest.harnesses[key];
  if (!h) throw new Error(`unsupported harness entry for ${condition}`);
  if (typeof h === "string") {
    return { kind: "single", path: h, phases: null, root: h };
  }
  if (h?.kind === "pipeline" && Array.isArray(h.phases)) {
    // Recorded matrix still uses the monolithic root agent for plumbing traces.
    if (runMode === "recorded") {
      return { kind: "single", path: h.root, phases: null, root: h.root };
    }
    return {
      kind: "pipeline",
      path: h.root,
      root: h.root,
      phases: h.phases.map((p) => ({ id: p.id, path: p.path })),
    };
  }
  if (h?.kind === "single" && h.path) {
    return { kind: "single", path: h.path, phases: null, root: h.path };
  }
  throw new Error(`unsupported harness entry for ${condition}`);
}

function harnessPath(manifest, condition, runMode = "live") {
  return join(root, harnessSpec(manifest, condition, runMode).path);
}

function harnessHashes(manifest) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, h] of Object.entries(manifest.harnesses)) {
    if (typeof h === "string") {
      out[k] = sha256File(join(root, h, "agent.yml"));
    } else if (h?.kind === "pipeline") {
      for (const p of h.phases ?? []) {
        out[`${k}/${p.id}`] = sha256File(join(root, p.path, "agent.yml"));
      }
    } else if (h?.path) {
      out[k] = sha256File(join(root, h.path, "agent.yml"));
    }
  }
  return out;
}

/**
 * Run Track A `fausth select` against a target harness; write agent.json under outDir.
 * @returns {{ ok: boolean, harnessDir: string, error?: string }}
 */
function runSelect(targetHarnessDir, patchPath, outDir) {
  mkdirSync(outDir, { recursive: true });
  const outAgent = join(outDir, "agent.json");
  try {
    run(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "select",
        targetHarnessDir,
        "--candidate-patch",
        patchPath,
        "--skip-fixtures",
        "true",
        "--out-agent",
        outAgent,
      ],
      { cwd: join(root, "engines/ts"), stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!existsSync(outAgent)) {
      return {
        ok: false,
        harnessDir: targetHarnessDir,
        error: `select succeeded but did not write ${outAgent}`,
      };
    }
    return { ok: true, harnessDir: outDir };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stderr = e && typeof e === "object" && "stderr" in e ? String(e.stderr) : "";
    return {
      ok: false,
      harnessDir: targetHarnessDir,
      error: (msg + (stderr ? `\n${stderr}` : "")).slice(0, 4000),
    };
  }
}

/**
 * After a mutable-skills phase: dump patch.json / decline.json and run Track A select.
 * - With a next phase: select onto next (within-pipeline inheritance).
 * - Without a next phase (implementation): select onto the current phase so the patch
 *   is materialized (needed for curriculum lineage carry across tasks).
 * - When curriculum=true: also select onto the current phase so the same role improves
 *   for the next task in the lineage.
 * - When skipSelect=true: dump patch/decline for audit only (frozen eval arm).
 * @returns {{
 *   disposition: string,
 *   selection_ok?: boolean,
 *   nextHarnessDir?: string | null,
 *   selfHarnessDir?: string | null,
 *   source?: string,
 * }}
 */
function recordPhaseReflection(opts) {
  const {
    eventsText,
    phaseDir,
    phaseHarnessDir,
    nextPhaseHarnessDir,
    phaseId,
    curriculum = false,
    skipSelect = false,
  } = opts;
  mkdirSync(phaseDir, { recursive: true });
  const events = parseEventsJsonl(eventsText);
  const declineEv = [...events]
    .reverse()
    .find(
      (e) =>
        e.stage === "record" &&
        e.reason === "harness_patch_declined" &&
        (e.tool === "harness.decline_skills_patch" || e.tool === "harness.reflect_skills"),
    );
  const patchEv = [...events]
    .reverse()
    .find(
      (e) =>
        e.stage === "execute" &&
        e.verdict === "allow" &&
        (e.tool === "harness.propose_skills_patch" ||
          (e.tool === "harness.reflect_skills" && e.args?.disposition === "propose")),
    );

  if (patchEv?.args?.ops) {
    const patchPath = join(phaseDir, "patch.json");
    writeFileSync(patchPath, JSON.stringify({ ops: patchEv.args.ops }, null, 2) + "\n");
    if (skipSelect) {
      writeFileSync(
        join(phaseDir, "selection.json"),
        JSON.stringify(
          {
            ok: false,
            skipped: true,
            reason: "mutations_frozen",
            source_harness: phaseHarnessDir,
          },
          null,
          2,
        ) + "\n",
      );
      return {
        disposition: "patch",
        selection_ok: false,
        nextHarnessDir: nextPhaseHarnessDir ?? null,
        selfHarnessDir: null,
        source: "frozen_skip",
      };
    }
    const selectionPath = join(phaseDir, "selection.json");

    /** @type {string | null} */
    let selfHarnessDir = null;
    const needSelfSelect = curriculum || !nextPhaseHarnessDir;
    if (needSelfSelect) {
      const self = runSelect(phaseHarnessDir, patchPath, join(phaseDir, "selected-self"));
      if (!self.ok) {
        writeFileSync(
          selectionPath,
          JSON.stringify(
            {
              ok: false,
              error: self.error,
              source_harness: phaseHarnessDir,
              target_harness: phaseHarnessDir,
              mode: "same_phase",
            },
            null,
            2,
          ) + "\n",
        );
        return {
          disposition: "patch",
          selection_ok: false,
          nextHarnessDir: nextPhaseHarnessDir ?? null,
          selfHarnessDir: null,
        };
      }
      selfHarnessDir = self.harnessDir;
    }

    /** @type {string | null} */
    let nextHarnessDir = nextPhaseHarnessDir ?? selfHarnessDir;
    let selectionOk = Boolean(selfHarnessDir) && !nextPhaseHarnessDir;
    if (nextPhaseHarnessDir) {
      const next = runSelect(nextPhaseHarnessDir, patchPath, join(phaseDir, "selected-next"));
      if (!next.ok) {
        writeFileSync(
          selectionPath,
          JSON.stringify(
            {
              ok: false,
              error: next.error,
              source_harness: phaseHarnessDir,
              target_harness: nextPhaseHarnessDir,
              selected_self: selfHarnessDir,
              mode: "next_phase",
            },
            null,
            2,
          ) + "\n",
        );
        return {
          disposition: "patch",
          selection_ok: false,
          nextHarnessDir: nextPhaseHarnessDir,
          selfHarnessDir,
        };
      }
      nextHarnessDir = next.harnessDir;
      selectionOk = true;
    }

    writeFileSync(
      selectionPath,
      JSON.stringify(
        {
          ok: selectionOk,
          source_harness: phaseHarnessDir,
          target_harness: nextPhaseHarnessDir ?? phaseHarnessDir,
          selected_harness: nextHarnessDir,
          selected_self: selfHarnessDir,
          curriculum: Boolean(curriculum),
        },
        null,
        2,
      ) + "\n",
    );
    return {
      disposition: "patch",
      selection_ok: selectionOk,
      nextHarnessDir,
      selfHarnessDir,
    };
  }

  if (declineEv) {
    writeFileSync(
      join(phaseDir, "decline.json"),
      JSON.stringify(
        {
          reason: declineEv.args?.reason ?? declineEv.observation?.reason ?? null,
          note: declineEv.args?.note ?? declineEv.observation?.note ?? null,
          source: "agent",
          tool: declineEv.tool ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    return { disposition: "decline", nextHarnessDir: nextPhaseHarnessDir ?? null };
  }

  writeFileSync(
    join(phaseDir, "decline.json"),
    JSON.stringify(
      {
        reason: "skills_already_adequate",
        note: `host auto-decline for phase ${phaseId ?? "unknown"} (no agent reflection tool call)`,
        source: "host_auto",
      },
      null,
      2,
    ) + "\n",
  );
  return {
    disposition: "decline",
    nextHarnessDir: nextPhaseHarnessDir ?? null,
    source: "host_auto",
  };
}

/** Lineage key for frozen-twin curriculum carry across tasks. */
function lineageKey(item) {
  return [item.condition, `rep${item.rep}`, item.model_id, item.deployment_id].join("__");
}

/**
 * Early vs late transfer slice for curriculum runs (first vs second half of task order).
 * @param {Array<Record<string, unknown>>} attempts
 * @param {string[]} taskOrder
 */
function curriculumTransfer(attempts, taskOrder) {
  const mid = Math.ceil(taskOrder.length / 2);
  const early = new Set(taskOrder.slice(0, mid));
  const late = new Set(taskOrder.slice(mid));
  /** @type {Record<string, { early: { n: number, ok: number }, late: { n: number, ok: number } }>} */
  const byCondition = {};
  for (const a of attempts) {
    if (a.status !== "scored" || !a.score) continue;
    const cond = String(a.condition);
    if (!byCondition[cond]) {
      byCondition[cond] = { early: { n: 0, ok: 0 }, late: { n: 0, ok: 0 } };
    }
    const tid = String(a.task_id);
    const bucket = early.has(tid) ? "early" : late.has(tid) ? "late" : null;
    if (!bucket) continue;
    byCondition[cond][bucket].n += 1;
    if (a.score.task_success === true) byCondition[cond][bucket].ok += 1;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [cond, slices] of Object.entries(byCondition)) {
    const earlyRate = slices.early.n ? slices.early.ok / slices.early.n : null;
    const lateRate = slices.late.n ? slices.late.ok / slices.late.n : null;
    out[cond] = {
      early_tasks: [...early],
      late_tasks: [...late],
      early: { ...slices.early, rate: earlyRate },
      late: { ...slices.late, rate: lateRate },
      late_minus_early:
        earlyRate != null && lateRate != null ? lateRate - earlyRate : null,
    };
  }
  return out;
}

function materializeAgentJson(srcDir, destAgentPath) {
  if (existsSync(join(srcDir, "agent.json"))) {
    writeFileSync(destAgentPath, readFileSync(join(srcDir, "agent.json")));
    return;
  }
  const yml = join(srcDir, "agent.yml");
  if (!existsSync(yml)) {
    throw new Error(`no agent.json/yml in ${srcDir}`);
  }
  const out = run(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "validate", srcDir],
    { cwd: join(root, "engines/ts"), stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = out.replace(/\r\n/g, "\n").split("\n");
  const jsonStart = lines.findIndex((l) => l.startsWith("{"));
  if (jsonStart < 0) {
    throw new Error(`validate did not emit IR JSON for ${srcDir}`);
  }
  writeFileSync(destAgentPath, lines.slice(jsonStart).join("\n").trimEnd() + "\n");
}

/**
 * Snapshot evolved (or stock mutable) phase agents into lineage/frozen/.
 * @param {{
 *   manifest: Record<string, unknown>,
 *   rawRoot: string,
 *   lineagePhases: Record<string, string> | null | undefined,
 *   runMode: string,
 * }} opts
 */
function freezeLineage(opts) {
  const { manifest, rawRoot, lineagePhases, runMode } = opts;
  const spec = harnessSpec(manifest, "mutable-skills", runMode);
  const frozenRoot = join(rawRoot, "lineage", "frozen");
  mkdirSync(frozenRoot, { recursive: true });
  /** @type {Record<string, string>} */
  const frozen = {};
  for (const phase of spec.phases ?? []) {
    const dest = join(frozenRoot, phase.id);
    mkdirSync(dest, { recursive: true });
    const stockDir = join(root, phase.path);
    const candidate = lineagePhases?.[phase.id];
    const srcDir =
      candidate &&
      (existsSync(join(candidate, "agent.json")) || existsSync(join(candidate, "agent.yml")))
        ? candidate
        : stockDir;
    materializeAgentJson(srcDir, join(dest, "agent.json"));
    frozen[phase.id] = dest;
  }
  writeFileSync(
    join(rawRoot, "lineage", "frozen.json"),
    JSON.stringify({ frozen_at: new Date().toISOString(), phases: frozen }, null, 2) + "\n",
  );
  console.error(`[case-study] froze lineage → ${relative(root, frozenRoot)}`);
  return frozen;
}

/**
 * Train pass1 vs pass2 success rates for train-freeze-eval runs.
 * @param {Array<Record<string, unknown>>} attempts
 */
function trainSummary(attempts) {
  /** @type {Record<string, { n: number, ok: number, tasks: string[] }>} */
  const byPass = {};
  for (const a of attempts) {
    if (a.phase !== "train" || a.status !== "scored" || !a.score) continue;
    const p = String(a.train_pass ?? 1);
    if (!byPass[p]) byPass[p] = { n: 0, ok: 0, tasks: [] };
    byPass[p].n += 1;
    if (a.score.task_success === true) byPass[p].ok += 1;
    byPass[p].tasks.push(`${a.task_id}:${a.score.task_success ? "Y" : "N"}`);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [p, s] of Object.entries(byPass)) {
    out[`pass${p}`] = {
      n: s.n,
      ok: s.ok,
      rate: s.n ? s.ok / s.n : null,
      tasks: s.tasks,
    };
  }
  const p1 = out.pass1?.rate ?? null;
  const p2 = out.pass2?.rate ?? null;
  out.pass2_minus_pass1 =
    p1 != null && p2 != null ? p2 - p1 : null;
  return out;
}

/**
 * Run one fausth CLI agent on a worktree. Appends events to dumpPath.
 * @returns {{ report: Record<string, unknown>, eventsText: string }}
 */
function runAgentPhase(opts) {
  const {
    harnessDir,
    deploymentPath,
    worktree,
    taskPrompt,
    maxSteps,
    dumpPath,
    reportPath,
    modelPath,
    applyOverlays,
  } = opts;
  const cliArgs = [
    "--import",
    "tsx",
    "src/cli.ts",
    "run",
    harnessDir,
    "--deployment",
    deploymentPath,
    "--workspace",
    worktree,
    "--task-file",
    taskPrompt,
    "--max-steps",
    String(maxSteps),
    "--dump",
    dumpPath,
    "--report",
    reportPath,
  ];
  if (modelPath) cliArgs.push("--model", modelPath);
  if (opts.applyOverlays) cliArgs.push("--apply-overlays");
  try {
    run(process.execPath, cliArgs, {
      cwd: join(root, "engines/ts"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (e) {
    if (!existsSync(reportPath) || !existsSync(dumpPath)) {
      const msg = e instanceof Error ? e.message : String(e);
      const stderr = e && typeof e === "object" && "stderr" in e ? String(e.stderr) : "";
      throw new Error(msg + (stderr ? `\n${stderr}` : ""));
    }
  }
  return {
    report: JSON.parse(readFileSync(reportPath, "utf8")),
    eventsText: readFileSync(dumpPath, "utf8"),
  };
}

/**
 * Run held-out grader in the worktree after the agent stops.
 * @returns {{ ground_truth_pass: boolean, test_tampering: boolean, seed_test_sha256: string, final_test_sha256: string | null, grade_exit_code: number | null, diff: string }}
 */
function gradeWorktree(worktree, taskPath, seedTestSha) {
  const seedTestPath = join(worktree, "src/app.test.js");
  const finalTestSha = existsSync(seedTestPath) ? sha256File(seedTestPath) : null;
  const testTampering = finalTestSha !== seedTestSha;

  const gdir = gradeDir(taskPath);
  const dest = join(worktree, "grade");
  if (existsSync(gdir)) {
    cpSync(gdir, dest, { recursive: true });
  }

  let gradeExit = null;
  let groundTruthPass = false;
  const gradeTest = join(dest, "app.grade.test.js");
  if (existsSync(gradeTest)) {
    try {
      run(process.execPath, ["--test", "grade/app.grade.test.js"], {
        cwd: worktree,
        stdio: ["ignore", "pipe", "pipe"],
      });
      gradeExit = 0;
      groundTruthPass = true;
    } catch (e) {
      gradeExit = typeof e?.status === "number" ? e.status : 1;
      groundTruthPass = false;
    }
  }

  let diff = "";
  try {
    diff = run("git", ["-C", worktree, "diff", "--", "src/"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    diff = "";
  }

  return {
    ground_truth_pass: groundTruthPass,
    test_tampering: testTampering,
    seed_test_sha256: seedTestSha,
    final_test_sha256: finalTestSha,
    grade_exit_code: gradeExit,
    diff,
  };
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadManifest(args.manifest);
  const manifest = loaded.data;
  const studyDir = loaded.dir;
  console.error(`[case-study] manifest: ${relative(root, loaded.path)}`);
  if (args.mode === "live" && args.kitModels == null) {
    args.kitModels = [...(manifest.matrix.live_kit_models ?? DEFAULT_LIVE_KIT_MODELS)];
  }
  const runId =
    args.runId ??
    `${args.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const rawRoot = join(root, manifest.outputs.raw_dir, runId);
  mkdirSync(rawRoot, { recursive: true });

  if (args.kitModels?.length) {
    console.error(`[case-study] KIT models: ${args.kitModels.join(", ")}`);
  }
  if (args.taskIds?.length) {
    console.error(`[case-study] tasks: ${args.taskIds.join(", ")}`);
  }
  if (args.reps != null) {
    console.error(`[case-study] reps: ${args.reps}`);
  }
  if (args.trainFreezeEval) {
    console.error(
      `[case-study] train-freeze-eval: ${args.trainPasses} train pass(es), then freeze + paired eval`,
    );
    console.error(
      `[case-study] shuffle seed: ${args.curriculumShuffleSeed}`,
    );
  } else if (args.curriculum) {
    console.error(
      "[case-study] curriculum: frozen-twin order (tasks walk inside each condition×rep lineage)",
    );
  }

  if (!args.skipConformance) {
    console.error("[case-study] running Track A conformance gate…");
    run("pnpm", ["ci:conformance"], { cwd: root, stdio: "inherit" });
  }

  for (const key of Object.keys(manifest.harnesses)) {
    const spec = harnessSpec(manifest, key, args.mode);
    const dirs =
      spec.kind === "pipeline"
        ? spec.phases.map((p) => join(root, p.path))
        : [join(root, spec.path)];
    for (const h of dirs) {
      run(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "validate", h],
        { cwd: join(root, "engines/ts"), stdio: "inherit" },
      );
    }
  }

  let plan = buildPlan(manifest, args.mode, {
    kitModels: args.kitModels,
    runRoot: rawRoot,
    taskIds: args.taskIds,
    reps: args.trainFreezeEval ? (args.reps ?? 1) : args.reps,
    curriculum: args.curriculum,
    trainFreezeEval: args.trainFreezeEval,
    trainPasses: args.trainPasses,
    shuffleCurriculum: args.shuffleCurriculum,
    curriculumShuffleSeed: args.curriculumShuffleSeed,
    conditions: args.conditions,
  });
  if (args.conditions?.length) {
    console.error(`[case-study] conditions: ${args.conditions.join(", ")}`);
  }
  if (args.limit != null && Number.isFinite(args.limit)) {
    plan = plan.slice(0, args.limit);
  }
  console.error(`[case-study] planned attempts: ${plan.length}`);

  const ledgerPath = join(rawRoot, "ledger.json");
  /** @type {Array<Record<string, unknown>>} */
  let attempts = [];
  if (args.resume && existsSync(ledgerPath)) {
    attempts = JSON.parse(readFileSync(ledgerPath, "utf8")).attempts ?? [];
  }
  const done = new Set(attempts.map((a) => a.attempt_id));

  /** @type {Map<string, Record<string, string>>} */
  const lineageByKey = new Map();
  const lineageRoot = join(rawRoot, "lineage");
  const resumeLineage =
    (args.curriculum || args.trainFreezeEval) &&
    args.resume &&
    existsSync(join(rawRoot, "lineage-index.json"));
  if (resumeLineage) {
    const idx = JSON.parse(readFileSync(join(rawRoot, "lineage-index.json"), "utf8"));
    for (const [k, phases] of Object.entries(idx ?? {})) {
      lineageByKey.set(k, { ...phases });
    }
    console.error(`[case-study] resumed ${lineageByKey.size} curriculum lineage(s)`);
  }

  const provenance = {
    study_id: manifest.study_id,
    protocol: manifest.protocol,
    mode: args.mode,
    run_id: runId,
    curriculum: Boolean(args.curriculum),
    train_freeze_eval: Boolean(args.trainFreezeEval),
    train_passes: args.trainFreezeEval ? args.trainPasses : null,
    curriculum_shuffle_seed: args.shuffleCurriculum
      ? args.curriculumShuffleSeed
      : null,
    commit_sha: gitSha(),
    started_at: new Date().toISOString(),
    max_steps: manifest.matrix.max_steps,
    kit_models: args.kitModels ?? null,
    task_ids: args.taskIds ?? manifest.tasks.map((t) => t.id),
    repetitions: args.trainFreezeEval
      ? (args.reps ?? 1)
      : (args.reps ?? manifest.matrix.repetitions),
    harness_hashes: harnessHashes(manifest),
    deployment_hashes: Object.fromEntries(
      Object.entries(manifest.deployments).map(([k, d]) => [
        k,
        sha256File(join(root, d.path)),
      ]),
    ),
  };

  writeFileSync(join(rawRoot, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");

  let frozenReady = existsSync(join(rawRoot, "lineage", "frozen", "implementation", "agent.json"));

  for (const item of plan) {
    const id = attemptId(item);
    if (done.has(id)) {
      console.error(`[skip] ${id}`);
      continue;
    }

    if (args.trainFreezeEval && item.phase === "eval" && !frozenReady) {
      const trainKey = lineageKey({
        condition: "mutable-skills",
        rep: item.rep,
        model_id: item.model_id,
        deployment_id: item.deployment_id,
      });
      freezeLineage({
        manifest,
        rawRoot,
        lineagePhases: lineageByKey.get(trainKey) ?? null,
        runMode: args.mode,
      });
      frozenReady = true;
    }

    const attemptDir = join(rawRoot, "attempts", id);
    mkdirSync(attemptDir, { recursive: true });
    const dumpPath = join(attemptDir, "events.jsonl");
    const reportPath = join(attemptDir, "report.json");

    if (item.api_key_env && !process.env[item.api_key_env]) {
      const row = {
        attempt_id: id,
        ...item,
        status: "infrastructure_failure",
        error: `missing ${item.api_key_env}`,
        artifacts: {},
      };
      attempts.push(row);
      writeFileSync(ledgerPath, JSON.stringify({ provenance, attempts }, null, 2) + "\n");
      console.error(`[infra] ${id}: missing ${item.api_key_env}`);
      continue;
    }

    let worktree = null;
    const started = Date.now();
    try {
      const boot = JSON.parse(
        run(process.execPath, [
          join(root, "scripts/disposable-worktree.mjs"),
          "bootstrap",
          "--parent",
          root,
          "--seed",
          seedDir(item.task_path),
        ]),
      );
      worktree = boot.worktree;
      const seedTestPath = join(worktree, "src/app.test.js");
      const seedTestSha = existsSync(seedTestPath) ? sha256File(seedTestPath) : "";

      const spec = harnessSpec(manifest, item.condition, args.mode);
      const dep = resolveRepoPath(item.deployment_path);
      const taskPrompt = join(root, item.task_path, "prompt.md");
      const recordedModel =
        args.mode === "recorded"
          ? join(studyDir, "recorded", item.task_id, `${item.condition}.model.jsonl`)
          : null;
      if (recordedModel && !existsSync(recordedModel)) {
        throw new Error(`missing recorded model trace: ${recordedModel}`);
      }

      /** @type {string[]} */
      const eventChunks = [];
      /** @type {Record<string, unknown>[]} */
      const phaseReports = [];
      let mergedReport = {
        harness: item.condition,
        completion_reached: false,
        event_count: 0,
        test_exit_code: null,
        model: item.model_id,
        phases: [],
        reflections: [],
      };

      if (spec.kind === "pipeline") {
        /** @type {string | null} */
        let inheritedHarnessDir = null;
        const mutationsFrozen =
          Boolean(item.mutations_frozen) || item.condition === "frozen-mutable";
        const useLineage =
          !mutationsFrozen &&
          (Boolean(item.curriculum) || args.curriculum) &&
          String(item.condition).includes("mutable");
        const lkey = useLineage
          ? lineageKey({
              condition: "mutable-skills",
              rep: item.rep,
              model_id: item.model_id,
              deployment_id: item.deployment_id,
            })
          : null;
        if (useLineage && lkey && !lineageByKey.has(lkey)) {
          lineageByKey.set(lkey, {});
        }
        const lineagePhases = lkey ? lineageByKey.get(lkey) : null;
        const frozenRoot = join(rawRoot, "lineage", "frozen");

        for (let pi = 0; pi < spec.phases.length; pi++) {
          const phase = spec.phases[pi];
          const nextPhase = spec.phases[pi + 1] ?? null;
          const phaseDump = join(attemptDir, `events.${phase.id}.jsonl`);
          const phaseReport = join(attemptDir, `report.${phase.id}.json`);
          const maxSteps =
            phase.id === "implementation"
              ? Number(manifest.matrix.max_steps ?? 30)
              : Math.min(14, Number(manifest.matrix.max_steps ?? 30));
          const stockDir = join(root, phase.path);
          const frozenDir = join(frozenRoot, phase.id);
          const lineageDir = lineagePhases?.[phase.id] ?? null;
          const harnessDir = mutationsFrozen
            ? existsSync(join(frozenDir, "agent.json"))
              ? frozenDir
              : stockDir
            : (inheritedHarnessDir ?? lineageDir ?? stockDir);
          const result = runAgentPhase({
            harnessDir,
            deploymentPath: dep,
            worktree,
            taskPrompt,
            maxSteps,
            dumpPath: phaseDump,
            reportPath: phaseReport,
            modelPath: null,
            applyOverlays: process.env.FAUSTH_APPLY_OVERLAYS === "1",
          });
          eventChunks.push(result.eventsText.trimEnd());
          phaseReports.push({ id: phase.id, ...result.report });
          const phaseRow = {
            id: phase.id,
            completion_reached: result.report.completion_reached,
            event_count: result.report.event_count,
            final_state: result.report.final_state,
            harness_dir: relative(root, harnessDir),
          };

          if (
            String(item.condition).includes("mutable") ||
            item.condition === "frozen-mutable"
          ) {
            const nextStock = nextPhase ? join(root, nextPhase.path) : null;
            const nextBase =
              nextPhase && lineagePhases?.[nextPhase.id]
                ? lineagePhases[nextPhase.id]
                : nextStock;
            const reflection = recordPhaseReflection({
              eventsText: result.eventsText,
              phaseDir: join(attemptDir, "phases", phase.id),
              phaseHarnessDir: harnessDir,
              nextPhaseHarnessDir: mutationsFrozen ? null : nextBase,
              phaseId: phase.id,
              curriculum: useLineage,
              skipSelect: mutationsFrozen,
            });
            phaseRow.reflection = reflection.disposition;
            if (reflection.selection_ok != null) phaseRow.selection_ok = reflection.selection_ok;
            mergedReport.reflections.push({
              phase: phase.id,
              disposition: reflection.disposition,
              selection_ok: reflection.selection_ok ?? null,
              source: reflection.source ?? "agent",
            });
            if (
              useLineage &&
              lineagePhases &&
              reflection.disposition === "patch" &&
              reflection.selection_ok
            ) {
              if (reflection.selfHarnessDir) {
                lineagePhases[phase.id] = reflection.selfHarnessDir;
              }
              if (nextPhase && reflection.nextHarnessDir) {
                lineagePhases[nextPhase.id] = reflection.nextHarnessDir;
              } else if (!nextPhase && reflection.nextHarnessDir) {
                lineagePhases[phase.id] = reflection.nextHarnessDir;
              }
              // Durable copy under rawRoot/lineage for resume.
              for (const [pid, hdir] of Object.entries(lineagePhases)) {
                const dest = join(lineageRoot, lkey, pid);
                mkdirSync(dest, { recursive: true });
                const srcAgent = join(hdir, "agent.json");
                if (existsSync(srcAgent)) {
                  writeFileSync(join(dest, "agent.json"), readFileSync(srcAgent));
                  lineagePhases[pid] = dest;
                } else {
                  // Do not keep dangling selected-* dirs without IR.
                  delete lineagePhases[pid];
                }
              }
              writeFileSync(
                join(rawRoot, "lineage-index.json"),
                JSON.stringify(Object.fromEntries(lineageByKey), null, 2) + "\n",
              );
            }
            inheritedHarnessDir =
              !mutationsFrozen &&
              reflection.disposition === "patch" &&
              reflection.selection_ok &&
              nextPhase
                ? reflection.nextHarnessDir
                : null;
            if (reflection.source === "host_auto") {
              console.error(`[info] ${id}: ${phase.id} host auto-declined skills reflection`);
            }
          } else {
            inheritedHarnessDir = null;
          }

          mergedReport.phases.push(phaseRow);
          if (result.report.model) mergedReport.model = result.report.model;
          if (result.report.test_exit_code != null) {
            mergedReport.test_exit_code = result.report.test_exit_code;
          }

          if (phase.id === "research" && !phaseYielded(result.eventsText)) {
            console.error(`[warn] ${id}: research did not phase.yield`);
          }
          if (phase.id === "plan") {
            if (!shouldStartImplementation(result.eventsText)) {
              console.error(`[warn] ${id}: plan did not user.approve — skipping implementation`);
              mergedReport.pipeline_blocked = "plan_not_approved";
              break;
            }
            if (!phaseYielded(result.eventsText)) {
              console.error(`[warn] ${id}: plan did not phase.yield`);
            }
          }
          if (phase.id === "implementation") {
            mergedReport.completion_reached = Boolean(result.report.completion_reached);
          }
        }
      } else {
        const result = runAgentPhase({
          harnessDir: join(root, spec.path),
          deploymentPath: dep,
          worktree,
          taskPrompt,
          maxSteps: Number(manifest.matrix.max_steps ?? 30),
          dumpPath,
          reportPath,
          modelPath: recordedModel,
          applyOverlays: process.env.FAUSTH_APPLY_OVERLAYS === "1",
        });
        eventChunks.push(result.eventsText.trimEnd());
        mergedReport = { ...result.report, phases: [{ id: "single", ...result.report }] };
      }

      const combinedEvents = eventChunks.filter(Boolean).join("\n") + "\n";
      writeFileSync(dumpPath, combinedEvents);
      mergedReport.event_count = combinedEvents.split(/\r?\n/).filter(Boolean).length;
      mergedReport.wall_time_ms = Date.now() - started;

      const grade = gradeWorktree(worktree, item.task_path, seedTestSha);
      writeFileSync(join(attemptDir, "worktree.diff"), grade.diff);
      writeFileSync(
        join(attemptDir, "grade.json"),
        JSON.stringify(
          {
            ground_truth_pass: grade.ground_truth_pass,
            test_tampering: grade.test_tampering,
            seed_test_sha256: grade.seed_test_sha256,
            final_test_sha256: grade.final_test_sha256,
            grade_exit_code: grade.grade_exit_code,
          },
          null,
          2,
        ) + "\n",
      );

      mergedReport.ground_truth_pass = grade.ground_truth_pass;
      mergedReport.test_tampering = grade.test_tampering;
      mergedReport.grade_exit_code = grade.grade_exit_code;
      writeFileSync(reportPath, JSON.stringify(mergedReport, null, 2) + "\n");
      const events = parseEventsJsonl(combinedEvents);
      const score = scoreAttempt(events, mergedReport);
      const row = {
        attempt_id: id,
        task_id: item.task_id,
        category: item.category,
        condition: item.condition,
        deployment_id: item.deployment_id,
        model_id: item.model_id ?? mergedReport.model,
        rep: item.rep,
        phase: item.phase ?? null,
        train_pass: item.train_pass ?? null,
        status: "scored",
        score,
        report_summary: {
          completion_reached: mergedReport.completion_reached,
          ground_truth_pass: grade.ground_truth_pass,
          test_tampering: grade.test_tampering,
          grade_exit_code: grade.grade_exit_code,
          test_exit_code: mergedReport.test_exit_code,
          event_count: mergedReport.event_count,
          wall_time_ms: mergedReport.wall_time_ms,
          engaged: score.engaged,
          phases: mergedReport.phases?.map((p) => p.id) ?? [],
        },
        artifacts: {
          events: dumpPath,
          report: reportPath,
          grade: join(attemptDir, "grade.json"),
          diff: join(attemptDir, "worktree.diff"),
          events_sha256: sha256File(dumpPath),
          report_sha256: sha256File(reportPath),
        },
      };
      attempts.push(row);
      console.error(
        `[ok] ${id} success=${score.task_success} engaged=${score.engaged} false_complete=${score.false_completion} denies=${score.deny_count}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const infra =
        /RATE_LIMIT|api_key|ECONN|ENOTFOUND|401|403|429|missing|adapter|workspace/i.test(msg);
      attempts.push({
        attempt_id: id,
        task_id: item.task_id,
        category: item.category,
        condition: item.condition,
        deployment_id: item.deployment_id,
        model_id: item.model_id,
        rep: item.rep,
        phase: item.phase ?? null,
        train_pass: item.train_pass ?? null,
        status: infra ? "infrastructure_failure" : "error",
        error: msg.slice(0, 2000),
        artifacts: {
          events: existsSync(dumpPath) ? dumpPath : null,
          report: existsSync(reportPath) ? reportPath : null,
        },
      });
      console.error(`[fail] ${id}: ${msg.slice(0, 200)}`);
    } finally {
      if (worktree) {
        try {
          run(process.execPath, [
            join(root, "scripts/disposable-worktree.mjs"),
            "cleanup",
            "--parent",
            root,
            "--worktree",
            worktree,
          ]);
        } catch {
          /* ignore */
        }
      }
      writeFileSync(ledgerPath, JSON.stringify({ provenance, attempts }, null, 2) + "\n");
    }
  }

  provenance.finished_at = new Date().toISOString();
  const evalAttempts = args.trainFreezeEval
    ? attempts.filter((a) => a.phase === "eval")
    : attempts;
  const aggregates = aggregateAttempts(
    args.trainFreezeEval ? evalAttempts : attempts,
  );
  const taskOrder =
    plan.find((p) => Array.isArray(p.task_order))?.task_order ??
    args.taskIds ??
    manifest.tasks.map((t) => t.id);
  const summary = {
    provenance,
    planned_attempts: plan.length,
    accounted_attempts: attempts.length,
    aggregates,
    ...(args.trainFreezeEval
      ? {
          train_summary: trainSummary(attempts),
          eval_paired_deltas: aggregates.paired_deltas,
          eval_aggregates: aggregates,
        }
      : {}),
    ...(args.curriculum && !args.trainFreezeEval
      ? { curriculum_transfer: curriculumTransfer(attempts, taskOrder) }
      : {}),
    attempts: attempts.map((a) => ({
      attempt_id: a.attempt_id,
      task_id: a.task_id,
      condition: a.condition,
      phase: a.phase ?? null,
      train_pass: a.train_pass ?? null,
      deployment_id: a.deployment_id,
      model_id: a.model_id,
      rep: a.rep,
      status: a.status,
      score: a.score ?? null,
      error: a.error ?? null,
      artifacts: a.artifacts
        ? {
            events_sha256: a.artifacts.events_sha256 ?? null,
            report_sha256: a.artifacts.report_sha256 ?? null,
          }
        : null,
    })),
  };

  const summaryPath =
    args.mode === "recorded"
      ? join(root, manifest.outputs.summary)
      : join(root, dirname(manifest.outputs.summary), `${runId}.summary.json`);
  mkdirSync(dirname(summaryPath), { recursive: true });
  const body = JSON.stringify(summary, null, 2) + "\n";
  writeFileSync(summaryPath, body);
  writeFileSync(join(rawRoot, "summary.json"), body);
  writeFileSync(
    join(rawRoot, "summary.sha256"),
    sha256Text(body) + "  summary.json\n",
  );

  console.log(
    JSON.stringify(
      {
        run_id: runId,
        mode: args.mode,
        curriculum: Boolean(args.curriculum),
        train_freeze_eval: Boolean(args.trainFreezeEval),
        planned: plan.length,
        accounted: attempts.length,
        scored: aggregates.n_scored,
        infrastructure: aggregates.n_infrastructure,
        summary: summaryPath,
        paired_deltas: aggregates.paired_deltas,
        train_summary: args.trainFreezeEval ? summary.train_summary : undefined,
        curriculum_transfer:
          args.curriculum && !args.trainFreezeEval
            ? summary.curriculum_transfer
            : undefined,
      },
      null,
      2,
    ),
  );

  const incomplete = plan.length !== attempts.length;
  const hardErrors = attempts.some((a) => a.status === "error");
  process.exit(incomplete || hardErrors ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
