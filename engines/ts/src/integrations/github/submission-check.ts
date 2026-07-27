/**
 * Deterministic SLOPATHON-style submission checks (no model).
 */

export type ReviewConclusion =
  | "pass"
  | "fail"
  | "action_required"
  | "neutral"
  | "infrastructure_error";

export type FindingCategory =
  | "incomplete_submission"
  | "scope_violation"
  | "missing_instructions"
  | "potential_secret"
  | "safety_concern"
  | "contradiction"
  | "human_review";

export type FindingSeverity = "info" | "warning" | "blocking";

export type ReviewFinding = {
  category: FindingCategory;
  severity: FindingSeverity;
  path: string;
  line_start?: number;
  evidence: string;
  recommendation: string;
};

export type ReviewPacketFile = {
  path: string;
  content: string;
  included: boolean;
  exclude_reason?: string;
};

export type ReviewPacket = {
  repo?: string;
  pr_number?: number;
  pr_title?: string;
  pr_body?: string;
  changed_paths: string[];
  files: ReviewPacketFile[];
  byte_budget: number;
  bytes_included: number;
  redacted: string[];
  deterministic_findings: ReviewFinding[];
  conclusion: ReviewConclusion;
  prompt_contract_version: string;
  created_at: string;
};

export type SubmissionCheckInput = {
  pr_title?: string;
  pr_body?: string;
  changed_paths: string[];
  /** path → text content for text files present in the PR / checkout slice */
  file_contents: Record<string, string>;
  byte_budget?: number;
  max_file_bytes?: number;
};

const SECRET_RE =
  /(?:api[_-]?key|secret|token|password)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{16,}/i;
const SK_RE = /\bsk-(?:or-)?[a-zA-Z0-9]{20,}\b/;
const SETUP_RE = /^#{1,3}\s*(setup|installation|getting started|install)\b/im;
const DEMO_RE = /^#{1,3}\s*(demo|usage|run|how to (run|use)|try it)\b/im;
const NOT_AVAILABLE_RE = /\b(demo\s*(link)?\s*:\s*)?(n\/?a|not available|none)\b/i;

const TEMPLATE_CHECKS = [
  /\[x\]\s*Our project lives inside one folder under `projects\/?`\.?/i,
  /\[x\]\s*We completed the project `README\.md`\.?/i,
  /\[x\]\s*We included setup and demo instructions\.?/i,
  /\[x\]\s*We did not commit passwords/i,
  /\[x\]\s*We have permission to publish/i,
];

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function projectFolders(paths: string[]): string[] {
  const folders = new Set<string>();
  for (const raw of paths) {
    const p = normalizePath(raw);
    const m = p.match(/^projects\/([^/]+)\//);
    if (m) folders.add(m[1]!);
    else if (/^projects\/[^/]+$/.test(p)) folders.add(p.slice("projects/".length));
  }
  return [...folders].sort();
}

function isUnderProject(path: string, folder: string): boolean {
  const p = normalizePath(path);
  return p === `projects/${folder}` || p.startsWith(`projects/${folder}/`);
}

function isAllowlistedOutside(path: string): boolean {
  const p = normalizePath(path);
  return (
    p === ".github/PULL_REQUEST_TEMPLATE.md" ||
    p === "README.md" ||
    p.startsWith(".github/") === false && p === "projects.json"
  );
}

function lineOf(content: string, needle: string): number | undefined {
  const idx = content.indexOf(needle);
  if (idx < 0) return undefined;
  return content.slice(0, idx).split(/\r?\n/).length;
}

/**
 * Build a normalized review packet and deterministic findings.
 */
export function runSubmissionCheck(input: SubmissionCheckInput): ReviewPacket {
  const byteBudget = input.byte_budget ?? 200_000;
  const maxFile = input.max_file_bytes ?? 100_000;
  const changed = input.changed_paths.map(normalizePath);
  const findings: ReviewFinding[] = [];
  const redacted: string[] = [];
  const files: ReviewPacketFile[] = [];
  let bytesIncluded = 0;

  // Path traversal
  for (const p of changed) {
    if (p.includes("..") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
      findings.push({
        category: "scope_violation",
        severity: "blocking",
        path: p,
        evidence: p,
        recommendation: "Remove path traversal or absolute paths from the PR.",
      });
    }
  }

  const folders = projectFolders(changed);
  if (folders.length === 0) {
    findings.push({
      category: "incomplete_submission",
      severity: "blocking",
      path: "projects/",
      evidence: changed.join(", ") || "(no paths)",
      recommendation: "Add exactly one project folder under projects/.",
    });
  } else if (folders.length > 1) {
    findings.push({
      category: "scope_violation",
      severity: "blocking",
      path: "projects/",
      evidence: folders.join(", "),
      recommendation: "Change only one projects/<name>/ folder per PR.",
    });
  }

  const folder = folders.length === 1 ? folders[0]! : null;

  if (folder) {
    for (const p of changed) {
      if (isUnderProject(p, folder)) continue;
      if (p === ".github/PULL_REQUEST_TEMPLATE.md" || p === "README.md") continue;
      // ignore pure meta if somehow listed
      findings.push({
        category: "scope_violation",
        severity: "blocking",
        path: p,
        evidence: p,
        recommendation: `Do not change files outside projects/${folder}/.`,
      });
    }

    const readmePath = `projects/${folder}/README.md`;
    const readme = input.file_contents[readmePath] ?? input.file_contents[normalizePath(readmePath)];
    if (readme === undefined || readme.trim().length === 0) {
      findings.push({
        category: "incomplete_submission",
        severity: "blocking",
        path: readmePath,
        evidence: readme === undefined ? "(missing)" : "(empty)",
        recommendation: "Add a non-empty projects/<name>/README.md.",
      });
    } else {
      if (!SETUP_RE.test(readme)) {
        findings.push({
          category: "missing_instructions",
          severity: "blocking",
          path: readmePath,
          line_start: 1,
          evidence: readme.slice(0, 120),
          recommendation: "Add a Setup / Installation section heading in the README.",
        });
      }
      if (!DEMO_RE.test(readme) && !NOT_AVAILABLE_RE.test(readme)) {
        findings.push({
          category: "missing_instructions",
          severity: "blocking",
          path: readmePath,
          line_start: 1,
          evidence: readme.slice(0, 120),
          recommendation: "Add a Demo / Usage section, or an explicit 'not available' note.",
        });
      }
    }
  }

  // PR template checkboxes
  const body = input.pr_body ?? "";
  if (body.trim().length > 0) {
    const missing: string[] = [];
    for (const re of TEMPLATE_CHECKS) {
      if (!re.test(body)) missing.push(re.source);
    }
    // Only enforce if body looks like the template (has Submission check)
    if (/submission check/i.test(body) && missing.length > 0) {
      findings.push({
        category: "incomplete_submission",
        severity: "blocking",
        path: ".github/PULL_REQUEST_TEMPLATE.md",
        evidence: `unchecked_boxes=${missing.length}`,
        recommendation: "Complete all required PR template checkboxes ([x]).",
      });
    }
  } else {
    findings.push({
      category: "incomplete_submission",
      severity: "blocking",
      path: "pull_request",
      evidence: "(empty PR body)",
      recommendation: "Fill in the PR template.",
    });
  }

  // File inclusion + secrets
  for (const [rawPath, content] of Object.entries(input.file_contents)) {
    const path = normalizePath(rawPath);
    const bytes = Buffer.byteLength(content, "utf8");
    let included = true;
    let exclude_reason: string | undefined;

    if (/\.(png|jpe?g|gif|webp|zip|tar|gz|exe|dll|bin)$/i.test(path)) {
      included = false;
      exclude_reason = "binary_extension";
    } else if (bytes > maxFile) {
      included = false;
      exclude_reason = "file_too_large";
    } else if (bytesIncluded + bytes > byteBudget) {
      included = false;
      exclude_reason = "byte_budget";
    }

    if (included && (SECRET_RE.test(content) || SK_RE.test(content))) {
      const evidence = (content.match(SK_RE)?.[0] ?? content.match(SECRET_RE)?.[0] ?? "secret").replace(
        /sk-[a-zA-Z0-9_-]+/g,
        "[REDACTED]",
      );
      redacted.push(path);
      findings.push({
        category: "potential_secret",
        severity: "blocking",
        path,
        line_start: lineOf(content, content.match(SK_RE)?.[0] ?? content.match(SECRET_RE)?.[0] ?? "") ?? 1,
        evidence,
        recommendation: "Remove credentials and rotate any exposed secrets.",
      });
      // still include but mark redacted — content replaced
      files.push({
        path,
        content: "[REDACTED: potential secret]",
        included: true,
      });
      bytesIncluded += Buffer.byteLength("[REDACTED: potential secret]", "utf8");
      continue;
    }

    if (included) {
      bytesIncluded += bytes;
      files.push({ path, content, included: true });
    } else {
      files.push({ path, content: "", included: false, exclude_reason });
    }
  }

  const blocking = findings.some((f) => f.severity === "blocking");
  const conclusion: ReviewConclusion = blocking ? "fail" : "pass";

  return {
    pr_title: input.pr_title,
    pr_body: input.pr_body,
    changed_paths: changed,
    files,
    byte_budget: byteBudget,
    bytes_included: bytesIncluded,
    redacted,
    deterministic_findings: findings,
    conclusion,
    prompt_contract_version: "slopathon-review/v0.1",
    created_at: new Date().toISOString(),
  };
}

/** Verify an AI finding against packet file contents. */
export function verifyFindingEvidence(
  finding: ReviewFinding,
  packet: ReviewPacket,
): { ok: true } | { ok: false; reason: string } {
  const file = packet.files.find((f) => f.path === finding.path && f.included);
  if (!file) return { ok: false, reason: "path_not_in_packet" };
  if (finding.evidence && !file.content.includes(finding.evidence)) {
    return { ok: false, reason: "evidence_not_found" };
  }
  if (finding.line_start !== undefined) {
    const lines = file.content.split(/\r?\n/);
    if (finding.line_start < 1 || finding.line_start > lines.length) {
      return { ok: false, reason: "line_out_of_range" };
    }
  }
  // absence: path must be under changed projects or allowlisted
  const folders = projectFolders(packet.changed_paths);
  if (folders.length === 1) {
    const folder = folders[0]!;
    if (
      !isUnderProject(finding.path, folder) &&
      finding.path !== ".github/PULL_REQUEST_TEMPLATE.md" &&
      finding.path !== "pull_request" &&
      finding.path !== "projects/"
    ) {
      return { ok: false, reason: "path_outside_submission" };
    }
  }
  return { ok: true };
}

export function filterVerifiedFindings(
  findings: ReviewFinding[],
  packet: ReviewPacket,
): { kept: ReviewFinding[]; dropped: { finding: ReviewFinding; reason: string }[] } {
  const kept: ReviewFinding[] = [];
  const dropped: { finding: ReviewFinding; reason: string }[] = [];
  for (const f of findings) {
    const v = verifyFindingEvidence(f, packet);
    if (v.ok) kept.push(f);
    else dropped.push({ finding: f, reason: v.reason });
  }
  return { kept, dropped };
}
