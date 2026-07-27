/**
 * Post Faust review results to GitHub (comment + optional check run).
 * Uses `gh` CLI; never embeds API keys.
 */
import { execFileSync } from "node:child_process";
import type { ReviewReport } from "./review-runtime.js";

export type PosterOptions = {
  repo: string;
  pr: number;
  /** When true, also create a check run named Faust review */
  checkRun?: boolean;
};

function conclusionForCheck(
  c: ReviewReport["conclusion"],
): "success" | "failure" | "neutral" | "action_required" {
  if (c === "pass") return "success";
  if (c === "fail") return "failure";
  if (c === "action_required") return "action_required";
  return "neutral";
}

export function postReviewComment(opts: PosterOptions, report: ReviewReport): void {
  const body = report.markdown;
  execFileSync(
    "gh",
    [
      "pr",
      "comment",
      String(opts.pr),
      "--repo",
      opts.repo,
      "--body",
      body,
    ],
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
  const conclusion = conclusionForCheck(report.conclusion);
  const payload = {
    name: "Faust review",
    head_sha: headSha,
    status: "completed",
    conclusion,
    output: {
      title: `Faust: ${report.conclusion}`,
      summary: report.markdown.slice(0, 65000),
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

export function postReviewToGithub(opts: PosterOptions, report: ReviewReport): void {
  postReviewComment(opts, report);
  if (opts.checkRun) postReviewCheckRun(opts, report);
}
