/**
 * Multi-fixture advisory usefulness matrix across all pinned OpenRouter + KIT models.
 * Scores TP/FP/FN against testdata expected.json files (deterministic-pass subtle issues).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadYamlFile, loadDeployment, loadAgentDir } from "./load.js";
import { createAdapterFromDeployment, toolsFromAgent } from "./model/index.js";
import { FaustRuntime } from "./runtime.js";
import type { Deployment, ModelProposal } from "./types.js";
import type { ModelProposal as PortProposal } from "./model/port.js";
import { packetFromFixtureDir } from "./integrations/github/packet-build.js";
import {
  buildAdvisoryPrompt,
  createReviewTools,
  formatReviewMarkdown,
  type ReviewToolState,
} from "./integrations/github/review-runtime.js";
import {
  filterVerifiedFindings,
  type ReviewFinding,
} from "./integrations/github/submission-check.js";
import { createConversationalPropose } from "./integrations/github/conversational-propose.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadDotEnv(path = join(root, ".env")): void {
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

loadDotEnv();

function toRuntimeProposal(p: PortProposal): ModelProposal {
  if (p.type === "tool") return { type: "tool", name: p.name, args: p.args };
  if (p.type === "stop") return { type: "stop", message: p.message };
  return { type: "stop", message: "" };
}

type Expectation = {
  label: string;
  expected_deterministic: "pass" | "fail";
  expect_categories_any?: string[];
  bonus_if_categories_any?: string[];
  min_ai_findings?: number;
  max_ai_findings?: number;
  forbid_recommendation_substrings?: string[];
};

type Score = {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  bonus_tp: number;
  policy_violations: number;
  notes: string[];
};

type Cell = {
  provider: string;
  model: string;
  fixture: string;
  ok: boolean;
  deterministic: string;
  conclusion?: string;
  model_used?: string;
  ai_findings: ReviewFinding[];
  dropped: number;
  score: Score;
  error?: string;
  elapsed_ms: number;
  report: string;
};

const FIXTURES = [
  "examples/slopathon-review/testdata/subtle-contradiction",
  "examples/slopathon-review/testdata/subtle-placeholder",
  "examples/slopathon-review/testdata/subtle-unsafe",
  "examples/slopathon-review/testdata/good-minimal",
  "examples/slopathon-review/testdata/injection-prompt",
];

function scoreFindings(exp: Expectation, kept: ReviewFinding[]): Score {
  const notes: string[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let bonus_tp = 0;
  let policy_violations = 0;

  const cats = new Set(kept.map((f) => f.category));
  const expect = exp.expect_categories_any ?? [];
  const bonus = exp.bonus_if_categories_any ?? [];
  const maxAi = exp.max_ai_findings;
  const minAi = exp.min_ai_findings ?? 0;

  for (const f of kept) {
    const rec = `${f.recommendation} ${f.evidence}`.toLowerCase();
    for (const bad of exp.forbid_recommendation_substrings ?? []) {
      if (rec.includes(bad.toLowerCase())) {
        policy_violations += 1;
        notes.push(`policy: matched "${bad}"`);
      }
    }
  }

  const requiredCatch = expect.length > 0 || minAi > 0;
  const hitRequired =
    expect.length === 0
      ? kept.length >= minAi
      : expect.some((c) => cats.has(c as ReviewFinding["category"]));

  if (requiredCatch) {
    if (hitRequired && kept.length >= minAi) {
      tp = 1;
      notes.push(`caught expected (${[...cats].join(",") || "count"})`);
    } else {
      fn = 1;
      notes.push(`missed expected categories [${expect.join(",")}] got [${[...cats].join(",")}]`);
    }
  } else if (maxAi === 0) {
    if (kept.length === 0) {
      tn = 1;
      notes.push("clean control: no findings");
    } else {
      fp = 1;
      notes.push(`false positives: ${[...cats].join(",")}`);
    }
  } else {
    tn = 1;
  }

  if (bonus.length && bonus.some((c) => cats.has(c as ReviewFinding["category"]))) {
    bonus_tp = 1;
    notes.push("bonus catch");
  }

  if (maxAi !== undefined && kept.length > maxAi && !requiredCatch) {
    // already counted as FP above when maxAi===0
  } else if (maxAi !== undefined && kept.length > maxAi && requiredCatch && tp) {
    // extra findings beyond need — soft FP note only
    notes.push(`extra findings beyond need: ${kept.length}`);
  }

  return { tp, fp, fn, tn, bonus_tp, policy_violations, notes };
}

async function runCell(
  baseDepPath: string,
  model: string,
  fixtureRel: string,
  outDir: string,
): Promise<Cell> {
  const base = loadDeployment(baseDepPath) as Deployment;
  const deployment: Deployment = {
    ...base,
    model: { ...base.model, models: [model] },
  };
  const provider = String(deployment.model.profile ?? deployment.model.transport);
  const fixtureName = fixtureRel.split(/[/\\]/).pop()!;
  const slug = `${provider}__${model.replace(/[/:]/g, "_")}__${fixtureName}`;
  const reportPath = join(outDir, `${slug}.json`);
  const exp = JSON.parse(
    readFileSync(join(root, fixtureRel, "expected.json"), "utf8"),
  ) as Expectation;
  const t0 = Date.now();

  try {
    const { adapter } = createAdapterFromDeployment(deployment);
    const packet = packetFromFixtureDir(join(root, fixtureRel));
    if (packet.conclusion !== exp.expected_deterministic) {
      throw new Error(
        `fixture ${fixtureName} deterministic=${packet.conclusion} expected ${exp.expected_deterministic}`,
      );
    }
    const agent = loadAgentDir(join(root, "examples/slopathon-review")).agent;
    const state: ReviewToolState = { packet, aiFindings: [] };
    const { system, user } = buildAdvisoryPrompt(packet);
    let runtime!: FaustRuntime;
    const propose = createConversationalPropose({
      adapter,
      tools: toolsFromAgent(agent.tools),
      system,
      user,
      getRuntime: () => runtime,
    });
    runtime = new FaustRuntime({
      agent,
      propose: async () => toRuntimeProposal(await propose()),
      tools: createReviewTools(state),
      allowJudge: false,
    });
    await runtime.runLoop(12);
    const { kept, dropped } = filterVerifiedFindings(state.aiFindings, packet);
    let conclusion = packet.conclusion;
    if (kept.some((f) => f.severity === "blocking" || f.category === "human_review")) {
      conclusion = "action_required";
    } else if (packet.conclusion === "pass" && kept.length > 0) {
      conclusion = "action_required";
    }
    const score = scoreFindings(exp, kept);
    const report = {
      mode: "advisory" as const,
      conclusion,
      deterministic: packet,
      ai_findings: kept,
      dropped_findings: dropped,
      model: adapter.lastModelUsed || model,
      provider,
      score,
      expectation: exp,
      markdown: formatReviewMarkdown({
        mode: "advisory",
        conclusion,
        deterministic: packet,
        ai_findings: kept,
        dropped_findings: dropped,
        model: adapter.lastModelUsed || model,
        provider,
      }),
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    return {
      provider,
      model,
      fixture: fixtureName,
      ok: true,
      deterministic: packet.conclusion,
      conclusion,
      model_used: adapter.lastModelUsed || model,
      ai_findings: kept,
      dropped: dropped.length,
      score,
      elapsed_ms: Date.now() - t0,
      report: reportPath,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const failScore: Score = {
      tp: 0,
      fp: 0,
      fn: 1,
      tn: 0,
      bonus_tp: 0,
      policy_violations: 0,
      notes: [`error: ${msg.slice(0, 200)}`],
    };
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          conclusion: msg.startsWith("RATE_LIMIT") ? "neutral" : "infrastructure_error",
          model,
          provider,
          error: msg,
          score: failScore,
        },
        null,
        2,
      ) + "\n",
    );
    return {
      provider,
      model,
      fixture: fixtureName,
      ok: false,
      deterministic: "?",
      conclusion: msg.startsWith("RATE_LIMIT") ? "neutral" : "infrastructure_error",
      ai_findings: [],
      dropped: 0,
      score: failScore,
      error: msg.slice(0, 400),
      elapsed_ms: Date.now() - t0,
      report: reportPath,
    };
  }
}

async function main() {
  const outDir = join(root, "live/reports/model-matrix-value");
  mkdirSync(outDir, { recursive: true });

  // Preflight deterministic expectations
  for (const f of FIXTURES) {
    const packet = packetFromFixtureDir(join(root, f));
    const exp = JSON.parse(readFileSync(join(root, f, "expected.json"), "utf8")) as Expectation;
    if (packet.conclusion !== exp.expected_deterministic) {
      console.error(
        `PREFLIGHT FAIL ${f}: deterministic=${packet.conclusion} expected ${exp.expected_deterministic}`,
        packet.deterministic_findings,
      );
      process.exit(2);
    }
    console.log(`preflight ok ${exp.label}: deterministic=${packet.conclusion}`);
  }

  const openrouter = loadYamlFile(join(root, "examples/slopathon-review/deployment.openrouter.yml")) as {
    model: { models: string[] };
  };
  const kit = loadYamlFile(join(root, "examples/slopathon-review/deployment.kit.yml")) as {
    model: { models: string[] };
  };

  const models: { dep: string; model: string }[] = [
    ...openrouter.model.models.map((m) => ({
      dep: join(root, "examples/slopathon-review/deployment.openrouter.yml"),
      model: m,
    })),
    ...kit.model.models.map((m) => ({
      dep: join(root, "examples/slopathon-review/deployment.kit.yml"),
      model: m,
    })),
  ];

  const cells: Cell[] = [];
  for (const m of models) {
    for (const fixture of FIXTURES) {
      console.log(`\n=== ${m.model} @ ${fixture.split(/[/\\]/).pop()} ===`);
      const cell = await runCell(m.dep, m.model, fixture, outDir);
      cells.push(cell);
      console.log(
        JSON.stringify({
          ok: cell.ok,
          score: cell.score,
          cats: cell.ai_findings.map((f) => f.category),
          elapsed_ms: cell.elapsed_ms,
          error: cell.error,
        }),
      );
    }
  }

  // Aggregate per model
  const byModel = new Map<string, Score & { cells: number; ok_runs: number }>();
  for (const c of cells) {
    const cur = byModel.get(c.model) ?? {
      tp: 0,
      fp: 0,
      fn: 0,
      tn: 0,
      bonus_tp: 0,
      policy_violations: 0,
      notes: [],
      cells: 0,
      ok_runs: 0,
    };
    cur.tp += c.score.tp;
    cur.fp += c.score.fp;
    cur.fn += c.score.fn;
    cur.tn += c.score.tn;
    cur.bonus_tp += c.score.bonus_tp;
    cur.policy_violations += c.score.policy_violations;
    cur.cells += 1;
    if (c.ok) cur.ok_runs += 1;
    byModel.set(c.model, cur);
  }

  const leaderboard = [...byModel.entries()]
    .map(([model, s]) => {
      const precision = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : null;
      const recall = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : null;
      const usefulness = s.tp + s.bonus_tp - s.fp - s.fn - s.policy_violations;
      return { model, ...s, precision, recall, usefulness };
    })
    .sort((a, b) => b.usefulness - a.usefulness);

  const summary = {
    created_at: new Date().toISOString(),
    fixtures: FIXTURES,
    cells,
    leaderboard,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  console.log("\n=== LEADERBOARD ===");
  for (const row of leaderboard) {
    console.log(
      JSON.stringify({
        model: row.model,
        tp: row.tp,
        fp: row.fp,
        fn: row.fn,
        tn: row.tn,
        bonus_tp: row.bonus_tp,
        policy_violations: row.policy_violations,
        usefulness: row.usefulness,
        precision: row.precision,
        recall: row.recall,
        ok_runs: row.ok_runs,
      }),
    );
  }
  console.log("Wrote", join(outDir, "summary.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
