/**
 * Multi-fixture advisory usefulness matrix across all pinned OpenRouter + KIT models.
 * Scores TP/FP/FN against testdata expected.json files (deterministic-pass subtle issues).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadYamlFile, loadDeployment, loadAgentDir } from "./load.js";
import { createAdapterFromDeployment, toolsFromAgent, toRuntimeProposal } from "./model/index.js";
import {
  aggregateLeaderboard,
  classifyCellError,
  emptyScore,
  scoreFindings,
  type CellErrorClass,
  type Expectation,
  type Score,
} from "./model/matrix-scoring.js";
import type { ModelInfraErrorKind } from "./model/errors.js";
import { FaustRuntime } from "./runtime.js";
import type { Deployment } from "./types.js";
import { packetFromFixtureDir } from "./integrations/github/packet-build.js";
import {
  buildAdvisoryPrompt,
  createReviewTools,
  formatReviewMarkdown,
  type ReviewToolState,
} from "./integrations/github/review-runtime.js";
import {
  filterVerifiedFindings,
  type ReviewConclusion,
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
  /** Set when the cell threw: no model behaviour was scored (excluded from leaderboard). */
  error_class?: CellErrorClass;
  infra_kind?: ModelInfraErrorKind;
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
    let conclusion: ReviewConclusion = packet.conclusion;
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
    // A throw is never model behaviour: infra (transport) or harness/setup error.
    const msg = e instanceof Error ? e.message : String(e);
    const info = classifyCellError(e);
    const score = emptyScore(`${info.error_class} error (not scored): ${msg.slice(0, 200)}`);
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          conclusion: info.conclusion,
          model,
          provider,
          error: msg,
          error_class: info.error_class,
          ...(info.infra_kind ? { infra_kind: info.infra_kind } : {}),
          score,
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
      conclusion: info.conclusion,
      ai_findings: [],
      dropped: 0,
      score,
      error_class: info.error_class,
      ...(info.infra_kind ? { infra_kind: info.infra_kind } : {}),
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

  // Aggregate per model — errored cells are counted separately, never scored.
  const leaderboard = aggregateLeaderboard(cells);

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
        scored_cells: row.scored_cells,
        infra_errors: row.infra_errors,
        setup_errors: row.setup_errors,
      }),
    );
  }
  console.log("Wrote", join(outDir, "summary.json"));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && resolve(entry!) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  loadDotEnv();
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
