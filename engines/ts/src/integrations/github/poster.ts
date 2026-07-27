/**
 * Report Faust review results into GitHub Actions Checks UI.
 * Default: step summary only (one check per workflow job — no duplicate Check Runs / PR comments).
 */
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ReviewFinding } from "./submission-check.js";
import type { ReviewReport } from "./review-runtime.js";

export type PosterOptions = {
  repo: string;
  pr: number;
  /** Opt-in PR comment (off by default). */
  comment?: boolean;
  /** Extra Check Run via API (off by default — duplicates the workflow job). */
  checkRun?: boolean;
  /** File annotations on the job (off by default — duplicates the summary). */
  annotate?: boolean;
};

type AnnotationLevel = "failure" | "warning" | "notice";

export type CheckAnnotation = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: AnnotationLevel;
  message: string;
  title: string;
};

function conclusionForCheck(
  c: ReviewReport["conclusion"],
): "success" | "failure" | "neutral" | "action_required" {
  if (c === "pass") return "success";
  if (c === "fail") return "failure";
  if (c === "action_required") return "action_required";
  return "neutral";
}

export function collectFindings(report: ReviewReport): ReviewFinding[] {
  return [...report.deterministic.deterministic_findings, ...report.ai_findings];
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** Short title for optional Check Run / job display. */
export function checkRunTitle(report: ReviewReport): string {
  const findings = collectFindings(report);
  if (findings.length === 0) {
    if (report.conclusion === "pass") return "Pass — no issues";
    if (report.conclusion === "infrastructure_error") return "Infrastructure error — review did not complete";
    if (report.conclusion === "neutral") return "Neutral — skipped (not a pass)";
    return `Conclusion: ${report.conclusion}`;
  }
  if (findings.length === 1) {
    const f = findings[0]!;
    return `${f.category}: ${truncate(f.recommendation, 72)}`;
  }
  const cats = [...new Set(findings.map((f) => f.category))];
  return `${findings.length} issues — ${cats.slice(0, 4).join(", ")}${cats.length > 4 ? "…" : ""}`;
}

function annotationLevel(sev: ReviewFinding["severity"]): AnnotationLevel {
  if (sev === "blocking") return "failure";
  if (sev === "warning") return "warning";
  return "notice";
}

export function findingsToAnnotations(findings: ReviewFinding[]): CheckAnnotation[] {
  return findings.slice(0, 50).map((f) => {
    const line = Math.max(1, f.line_start ?? 1);
    return {
      path: f.path || ".",
      start_line: line,
      end_line: line,
      annotation_level: annotationLevel(f.severity),
      title: f.category,
      message: truncate(f.recommendation, 200),
    };
  });
}

/** Write the readable report into the job's Checks summary panel. */
export function writeGithubStepSummary(report: ReviewReport): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, report.markdown.endsWith("\n") ? report.markdown : `${report.markdown}\n`, "utf8");
}

/** Optional file annotations (can clutter the Checks view — off by default). */
export function emitGithubActionsAnnotations(report: ReviewReport): void {
  for (const f of collectFindings(report)) {
    const level = f.severity === "blocking" ? "error" : f.severity === "warning" ? "warning" : "notice";
    const file = f.path || ".";
    const line = Math.max(1, f.line_start ?? 1);
    const msg = truncate(`${f.category}: ${f.recommendation}`, 200).replace(/%/g, "%25").replace(/\r?\n/g, "%0A");
    console.log(`::${level} file=${file},line=${line},title=${f.category}::${msg}`);
  }
  if (report.conclusion === "infrastructure_error" || report.conclusion === "neutral") {
    console.log(
      `::error title=${report.conclusion}::${truncate(checkRunTitle(report), 200)}`,
    );
  }
}

export function postReviewComment(opts: PosterOptions, report: ReviewReport): void {
  execFileSync(
    "gh",
    ["pr", "comment", String(opts.pr), "--repo", opts.repo, "--body", report.markdown],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

export function postReviewCheckRun(opts: PosterOptions, report: ReviewReport): void {
  const [owner, name] = opts.repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo: ${opts.repo}`);

  const pr = execFileSync(
    "gh",
    ["pr", "view", String(opts.pr), "--repo", opts.repo, "--json", "headRefOid"],
    { encoding: "utf8" },
  );
  const headSha = (JSON.parse(pr) as { headRefOid: string }).headRefOid;
  const checkName = report.mode === "advisory" ? "Submission L2" : "Submission L1";
  const payload = {
    name: checkName,
    head_sha: headSha,
    status: "completed",
    conclusion: conclusionForCheck(report.conclusion),
    output: {
      title: checkRunTitle(report),
      summary: report.markdown.slice(0, 65000),
      // empty: summary is the source of truth; avoid duplicate annotation blocks
      annotations: [] as CheckAnnotation[],
    },
  };
  execFileSync(
    "gh",
    ["api", `repos/${owner}/${name}/check-runs`, "--method", "POST", "--input", "-"],
    {
      encoding: "utf8",
      input: JSON.stringify(payload),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

/**
 * Default: step summary only (workflow job is the check).
 * Opt-in: `--annotate`, `--check-run`, `--comment`.
 */
export function postReviewToGithub(opts: PosterOptions, report: ReviewReport): void {
  writeGithubStepSummary(report);
  if (opts.annotate) emitGithubActionsAnnotations(report);
  if (opts.checkRun) postReviewCheckRun(opts, report);
  if (opts.comment) postReviewComment(opts, report);
}

/** Always enrich local/CI output when a summary file exists. */
export function publishReviewOutput(report: ReviewReport, opts?: PosterOptions): void {
  writeGithubStepSummary(report);
  if (!opts) return;
  if (opts.annotate) emitGithubActionsAnnotations(report);
  if (opts.checkRun && opts.repo && opts.pr) postReviewCheckRun(opts, report);
  if (opts.comment && opts.repo && opts.pr) postReviewComment(opts, report);
}
