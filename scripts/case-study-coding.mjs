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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") out.mode = argv[++i] ?? "recorded";
    else if (a === "--resume") out.resume = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--skip-conformance") out.skipConformance = true;
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--reps") out.reps = Number(argv[++i]);
    else if (a === "--tasks") {
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

function loadManifest() {
  const path = join(root, "case-studies/coding-counterbalance/manifest.yml");
  return parseYaml(readFileSync(path, "utf8"));
}

function sanitizeIdPart(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function attemptId(a) {
  return [
    a.task_id,
    a.condition,
    a.deployment_id,
    sanitizeIdPart(a.model_id),
    `rep${a.rep}`,
  ].join("__");
}

function resolveRepoPath(p) {
  return isAbsolute(p) ? p : join(root, p);
}

function kitDeploymentPath(modelId, runRoot) {
  const safe = sanitizeIdPart(modelId);
  const dir = join(runRoot, "deployments");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `local-kit__${safe}.yml`);
  if (existsSync(out)) return relative(root, out);

  const basePath = join(root, "case-studies/coding-counterbalance/deployments/local-kit.yml");
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
  const conditions = manifest.matrix.conditions;
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
  const taskFilter = opts.taskIds?.length ? new Set(opts.taskIds) : null;
  const tasks = taskFilter
    ? manifest.tasks.filter((t) => taskFilter.has(t.id))
    : manifest.tasks;
  if (taskFilter) {
    const missing = [...taskFilter].filter((id) => !manifest.tasks.some((t) => t.id === id));
    if (missing.length) throw new Error(`unknown --tasks ids: ${missing.join(", ")}`);
  }

  for (const task of tasks) {
    for (const dep of deployments) {
      const modelVariants =
        mode === "live" && dep.deployment_id === "kit" && kitModels?.length
          ? kitModels.map((modelId) => ({
              model_id: modelId,
              deployment_path: runRoot
                ? kitDeploymentPath(modelId, runRoot)
                : dep.path,
            }))
          : [{ model_id: dep.model_id, deployment_path: dep.path }];

      for (const variant of modelVariants) {
        for (const condition of conditions) {
          for (let rep = 1; rep <= reps; rep++) {
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
            });
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
  const h = manifest.harnesses[condition];
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
  const manifest = loadManifest();
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
    reps: args.reps,
  });
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

  const provenance = {
    study_id: manifest.study_id,
    protocol: manifest.protocol,
    mode: args.mode,
    run_id: runId,
    commit_sha: gitSha(),
    started_at: new Date().toISOString(),
    max_steps: manifest.matrix.max_steps,
    kit_models: args.kitModels ?? null,
    task_ids: args.taskIds ?? manifest.tasks.map((t) => t.id),
    repetitions: args.reps ?? manifest.matrix.repetitions,
    harness_hashes: harnessHashes(manifest),
    deployment_hashes: Object.fromEntries(
      Object.entries(manifest.deployments).map(([k, d]) => [
        k,
        sha256File(join(root, d.path)),
      ]),
    ),
  };

  writeFileSync(join(rawRoot, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");

  for (const item of plan) {
    const id = attemptId(item);
    if (done.has(id)) {
      console.error(`[skip] ${id}`);
      continue;
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
          ? join(
              root,
              "case-studies/coding-counterbalance/recorded",
              item.task_id,
              `${item.condition}.model.jsonl`,
            )
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
      };

      if (spec.kind === "pipeline") {
        for (const phase of spec.phases) {
          const phaseDump = join(attemptDir, `events.${phase.id}.jsonl`);
          const phaseReport = join(attemptDir, `report.${phase.id}.json`);
          const maxSteps =
            phase.id === "implementation"
              ? Number(manifest.matrix.max_steps ?? 30)
              : Math.min(12, Number(manifest.matrix.max_steps ?? 30));
          const result = runAgentPhase({
            harnessDir: join(root, phase.path),
            deploymentPath: dep,
            worktree,
            taskPrompt,
            maxSteps,
            dumpPath: phaseDump,
            reportPath: phaseReport,
            modelPath: null,
          });
          eventChunks.push(result.eventsText.trimEnd());
          phaseReports.push({ id: phase.id, ...result.report });
          mergedReport.phases.push({
            id: phase.id,
            completion_reached: result.report.completion_reached,
            event_count: result.report.event_count,
            final_state: result.report.final_state,
          });
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
  const aggregates = aggregateAttempts(attempts);
  const summary = {
    provenance,
    planned_attempts: plan.length,
    accounted_attempts: attempts.length,
    aggregates,
    attempts: attempts.map((a) => ({
      attempt_id: a.attempt_id,
      task_id: a.task_id,
      condition: a.condition,
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
        planned: plan.length,
        accounted: attempts.length,
        scored: aggregates.n_scored,
        infrastructure: aggregates.n_infrastructure,
        summary: summaryPath,
        paired_deltas: aggregates.paired_deltas,
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
