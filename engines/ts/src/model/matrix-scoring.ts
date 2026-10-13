/**
 * Pure scoring/aggregation for the advisory model matrix (run-model-matrix.ts).
 *
 * Honesty rule: a cell that threw produced no model behaviour to score. It is excluded
 * from TP/FP/FN/TN and from the precision/recall/usefulness denominators, and counted
 * separately by cause: transport infra failure, request rejected by the endpoint (the
 * harness built a request it refuses — context overflow, invalid schema; surfaced, not
 * hidden as an outage), or harness/setup error.
 */
import type { ReviewFinding } from "../integrations/github/submission-check.js";
import {
  isModelInfraError,
  isModelRequestError,
  modelTransportErrorJson,
  type ModelInfraErrorKind,
  type ModelTransportErrorJson,
} from "./errors.js";

export type Expectation = {
  label: string;
  expected_deterministic: "pass" | "fail";
  expect_categories_any?: string[];
  bonus_if_categories_any?: string[];
  min_ai_findings?: number;
  max_ai_findings?: number;
  forbid_recommendation_substrings?: string[];
};

export type Score = {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  bonus_tp: number;
  policy_violations: number;
  notes: string[];
};

/** Why a cell has no model score. */
export type CellErrorClass = "infra" | "request_rejected" | "setup";

export type CellErrorInfo = {
  error_class: CellErrorClass;
  infra_kind?: ModelInfraErrorKind;
  /** Structured transport error (kind/status/model/attempts/total_attempts/message). */
  transport_error?: ModelTransportErrorJson;
  /** Review conclusion for the cell report: never a pass. */
  conclusion: "neutral" | "infrastructure_error";
};

/** Minimal cell shape needed for aggregation. */
export type ScoredCell = {
  model: string;
  ok: boolean;
  score: Score;
  error_class?: CellErrorClass;
};

export type LeaderboardRow = Score & {
  model: string;
  cells: number;
  ok_runs: number;
  /** Cells that produced model behaviour and entered the denominators. */
  scored_cells: number;
  infra_errors: number;
  /** Requests the endpoint rejected (harness-caused; not an outage, not a model failure). */
  request_rejected: number;
  setup_errors: number;
  precision: number | null;
  recall: number | null;
  usefulness: number;
};

export function emptyScore(note?: string): Score {
  return { tp: 0, fp: 0, fn: 0, tn: 0, bonus_tp: 0, policy_violations: 0, notes: note ? [note] : [] };
}

/** Classify a thrown cell error. No class is a model failure. */
export function classifyCellError(e: unknown): CellErrorInfo {
  const transport_error = modelTransportErrorJson(e) ?? undefined;
  if (isModelInfraError(e)) {
    return {
      error_class: "infra",
      infra_kind: e.kind,
      ...(transport_error ? { transport_error } : {}),
      conclusion: e.kind === "rate_limit" ? "neutral" : "infrastructure_error",
    };
  }
  if (isModelRequestError(e)) {
    return {
      error_class: "request_rejected",
      ...(transport_error ? { transport_error } : {}),
      conclusion: "infrastructure_error",
    };
  }
  return { error_class: "setup", conclusion: "infrastructure_error" };
}

export function scoreFindings(exp: Expectation, kept: ReviewFinding[]): Score {
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

  if (maxAi !== undefined && kept.length > maxAi && requiredCatch && tp) {
    // extra findings beyond need — soft FP note only
    notes.push(`extra findings beyond need: ${kept.length}`);
  }

  return { tp, fp, fn, tn, bonus_tp, policy_violations, notes };
}

/** Per-model leaderboard; errored cells are counted but never scored. */
export function aggregateLeaderboard(cells: ScoredCell[]): LeaderboardRow[] {
  const byModel = new Map<string, LeaderboardRow>();
  for (const c of cells) {
    const cur =
      byModel.get(c.model) ??
      ({
        model: c.model,
        ...emptyScore(),
        cells: 0,
        ok_runs: 0,
        scored_cells: 0,
        infra_errors: 0,
        request_rejected: 0,
        setup_errors: 0,
        precision: null,
        recall: null,
        usefulness: 0,
      } satisfies LeaderboardRow);
    cur.cells += 1;
    if (c.ok) cur.ok_runs += 1;
    if (c.error_class === "infra") {
      cur.infra_errors += 1;
    } else if (c.error_class === "request_rejected") {
      cur.request_rejected += 1;
    } else if (c.error_class === "setup") {
      cur.setup_errors += 1;
    } else {
      cur.scored_cells += 1;
      cur.tp += c.score.tp;
      cur.fp += c.score.fp;
      cur.fn += c.score.fn;
      cur.tn += c.score.tn;
      cur.bonus_tp += c.score.bonus_tp;
      cur.policy_violations += c.score.policy_violations;
    }
    byModel.set(c.model, cur);
  }
  return [...byModel.values()]
    .map((s) => ({
      ...s,
      precision: s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : null,
      recall: s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : null,
      usefulness: s.tp + s.bonus_tp - s.fp - s.fn - s.policy_violations,
    }))
    .sort((a, b) => b.usefulness - a.usefulness);
}
