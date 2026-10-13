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

/** Closed category set for findings (deterministic + advisory). */
export const FINDING_CATEGORIES: readonly FindingCategory[] = [
  "incomplete_submission",
  "scope_violation",
  "missing_instructions",
  "potential_secret",
  "safety_concern",
  "contradiction",
  "human_review",
];

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["info", "warning", "blocking"];

/** Severities the advisory (model) layer may use; `blocking` is reserved for deterministic checks. */
export const ADVISORY_SEVERITIES: readonly FindingSeverity[] = ["info", "warning"];

/** Closed set of evidence-gate rejection reasons (D12). */
export const FINDING_REJECT_REASONS = [
  "invalid_category",
  "invalid_severity",
  "severity_reserved_for_deterministic",
  "invalid_path",
  "path_not_in_packet",
  "path_outside_submission",
  "evidence_empty",
  "evidence_not_found",
  "line_invalid",
  "line_out_of_range",
  "recommendation_empty",
] as const;

export type FindingRejectReason = (typeof FINDING_REJECT_REASONS)[number];

/**
 * Closed list of secret shapes. The same list drives detection (potential_secret findings,
 * packet redaction) and output redaction, so anything we would mask is also flagged.
 * `keep`: capture group 1 is kept verbatim (e.g. the key name in `password: …`).
 * Order matters: specific token shapes before the generic `key = value` form.
 */
const SECRET_PATTERNS: ReadonlyArray<{ id: string; re: RegExp; keep?: true }> = [
  {
    id: "private_key_block",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/,
  },
  { id: "openai_style_key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: "aws_access_key_id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "bearer_token", re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/i, keep: true },
  {
    id: "assignment",
    re: /((?:api[_-]?key|secret|token|password)\s*[=:]\s*['"]?)[A-Za-z0-9_\-]{16,}/i,
    keep: true,
  },
];

function secretRegex(p: (typeof SECRET_PATTERNS)[number], global: boolean): RegExp {
  // Fresh instance per use: no shared lastIndex state between callers.
  return new RegExp(p.re.source, global ? `${p.re.flags}g` : p.re.flags);
}

/** First secret-shaped match in `text` (lowest index), or null. */
export function findSecret(text: string): { id: string; index: number; match: string } | null {
  let best: { id: string; index: number; match: string } | null = null;
  for (const p of SECRET_PATTERNS) {
    const m = secretRegex(p, false).exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { id: p.id, index: m.index, match: m[0] };
    }
  }
  return best;
}

export function containsSecret(text: string): boolean {
  return findSecret(text) !== null;
}

/**
 * Replace every secret-shaped substring. Used on everything that leaves the process
 * (finding evidence, markdown, annotations, check-run text, prompts).
 */
export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const p of SECRET_PATTERNS) {
    out = out.replace(secretRegex(p, true), (...m: unknown[]) =>
      p.keep ? `${String(m[1] ?? "")}[REDACTED]` : `[REDACTED:${p.id}]`,
    );
  }
  return out;
}

/** Redact first, then cut — so a slice can never expose a partial secret. */
function redactedSlice(text: string, max: number): string {
  return redactSecrets(text).slice(0, max);
}

const SETUP_RE = /^#{1,3}\s*(setup|installation|getting started|install)\b/im;
const DEMO_RE = /^#{1,3}\s*(demo|usage|run|how to (run|use)|try it)\b/im;
/**
 * Explicit, demo-specific "not available" notes only ("Demo: n/a", "no demo available",
 * "the demo is not available"). A bare "none"/"n/a" elsewhere must not waive the check.
 */
const NOT_AVAILABLE_RES: readonly RegExp[] = [
  /\bdemo(?:\s+link)?\s*[:\-\u2013\u2014]\s*(?:n\/a|na|none|not available|unavailable)\b/i,
  /\bno\s+demo\s+(?:is\s+)?available\b/i,
  /\bdemo\s+(?:is\s+)?(?:not\s+(?:yet\s+)?available|unavailable)\b/i,
];

function hasDemoNotAvailableNote(readme: string): boolean {
  return NOT_AVAILABLE_RES.some((re) => re.test(readme));
}

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

function lineOf(content: string, needle: string): number | undefined {
  const idx = content.indexOf(needle);
  if (idx < 0) return undefined;
  return content.slice(0, idx).split(/\r?\n/).length;
}

/** Basename looks like a project README (case-insensitive; .md / .txt / .markdown / bare). */
export function isReadmeBasename(name: string): boolean {
  return /^readme(\.(md|txt|markdown))?$/i.test(name);
}

/**
 * Resolve a project README from changed paths + file contents.
 * Prefers README.md (any case), then other .md/.markdown, then .txt, then bare README.
 */
export function resolveProjectReadme(
  folder: string,
  changed_paths: string[],
  file_contents: Record<string, string>,
): { path: string; content: string } | null {
  const prefix = `projects/${folder}/`;
  const contentByNorm = new Map<string, { path: string; content: string }>();
  for (const [raw, content] of Object.entries(file_contents)) {
    contentByNorm.set(normalizePath(raw).toLowerCase(), { path: normalizePath(raw), content });
  }

  const candidates = new Set<string>();
  for (const raw of [...changed_paths, ...Object.keys(file_contents)]) {
    const p = normalizePath(raw);
    if (!p.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const base = p.slice(prefix.length);
    if (!base.includes("/") && isReadmeBasename(base)) candidates.add(p);
  }

  if (candidates.size === 0) return null;

  const ranked = [...candidates].sort((a, b) => {
    const score = (p: string): number => {
      const base = p.slice(prefix.length);
      if (/^readme\.md$/i.test(base)) return 0;
      if (/\.md$/i.test(base) || /\.markdown$/i.test(base)) return 1;
      if (/\.txt$/i.test(base)) return 2;
      return 3;
    };
    const d = score(a) - score(b);
    return d !== 0 ? d : a.localeCompare(b);
  });

  for (const path of ranked) {
    const hit =
      contentByNorm.get(path.toLowerCase()) ??
      contentByNorm.get(normalizePath(path).toLowerCase());
    if (hit && hit.content.trim().length > 0) {
      return { path: hit.path, content: hit.content };
    }
    // Path listed but content missing / empty — keep looking
    if (hit && hit.content.trim().length === 0) continue;
  }

  // Prefer reporting the best-ranked path even if empty/missing content
  const best = ranked[0]!;
  const empty = contentByNorm.get(best.toLowerCase());
  return { path: empty?.path ?? best, content: empty?.content ?? "" };
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

    const resolved = resolveProjectReadme(folder, changed, input.file_contents);
    if (!resolved || resolved.content.trim().length === 0) {
      findings.push({
        category: "incomplete_submission",
        severity: "blocking",
        path: resolved?.path ?? `projects/${folder}/README.md`,
        evidence: !resolved ? "(missing)" : "(empty)",
        recommendation:
          "Add a non-empty project README (README.md preferred; Readme.txt / readme.md also accepted).",
      });
    } else {
      const { path: readmePath, content: readme } = resolved;
      if (!SETUP_RE.test(readme)) {
        findings.push({
          category: "missing_instructions",
          severity: "blocking",
          path: readmePath,
          line_start: 1,
          evidence: redactedSlice(readme, 120),
          recommendation: "Add a Setup / Installation section heading in the README.",
        });
      }
      if (!DEMO_RE.test(readme) && !hasDemoNotAvailableNote(readme)) {
        findings.push({
          category: "missing_instructions",
          severity: "blocking",
          path: readmePath,
          line_start: 1,
          evidence: redactedSlice(readme, 120),
          recommendation: "Add a Demo / Usage section, or an explicit 'Demo: not available' note.",
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

    const secret = included ? findSecret(content) : null;
    if (secret) {
      redacted.push(path);
      findings.push({
        category: "potential_secret",
        severity: "blocking",
        path,
        line_start: lineOf(content, secret.match) ?? 1,
        // Never the value: the masked match (keeps e.g. the key name) or the shape id.
        evidence: redactSecrets(secret.match).slice(0, 120),
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

  // Defense in depth: nothing secret-shaped may leave via finding text.
  for (const f of findings) {
    f.evidence = redactSecrets(f.evidence);
    f.recommendation = redactSecrets(f.recommendation);
    f.path = redactSecrets(f.path);
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

function isOneOf<T extends string>(v: unknown, set: readonly T[]): v is T {
  return typeof v === "string" && (set as readonly string[]).includes(v);
}

/**
 * Verify an advisory (model) finding against packet file contents.
 * Strict: closed category/severity enums, non-empty evidence that occurs verbatim in an
 * included file, integer line_start within the file, path inside the submission.
 * `blocking` is reserved for the deterministic layer.
 */
export function verifyFindingEvidence(
  finding: ReviewFinding,
  packet: ReviewPacket,
): { ok: true } | { ok: false; reason: FindingRejectReason } {
  const f = finding as unknown as Record<string, unknown>;
  if (!isOneOf(f.category, FINDING_CATEGORIES)) return { ok: false, reason: "invalid_category" };
  if (!isOneOf(f.severity, FINDING_SEVERITIES)) return { ok: false, reason: "invalid_severity" };
  if (!isOneOf(f.severity, ADVISORY_SEVERITIES)) {
    return { ok: false, reason: "severity_reserved_for_deterministic" };
  }
  if (typeof f.path !== "string" || f.path.length === 0) return { ok: false, reason: "invalid_path" };
  if (typeof f.recommendation !== "string" || f.recommendation.trim().length === 0) {
    return { ok: false, reason: "recommendation_empty" };
  }
  const file = packet.files.find((pf) => pf.path === f.path && pf.included);
  if (!file) return { ok: false, reason: "path_not_in_packet" };
  if (typeof f.evidence !== "string" || f.evidence.trim().length === 0) {
    return { ok: false, reason: "evidence_empty" };
  }
  if (!file.content.includes(f.evidence)) {
    return { ok: false, reason: "evidence_not_found" };
  }
  if (f.line_start !== undefined) {
    if (typeof f.line_start !== "number" || !Number.isInteger(f.line_start)) {
      return { ok: false, reason: "line_invalid" };
    }
    const lines = file.content.split(/\r?\n/);
    if (f.line_start < 1 || f.line_start > lines.length) {
      return { ok: false, reason: "line_out_of_range" };
    }
  }
  // absence: path must be under changed projects or allowlisted
  const folders = projectFolders(packet.changed_paths);
  if (folders.length === 1) {
    const folder = folders[0]!;
    if (
      !isUnderProject(f.path, folder) &&
      f.path !== ".github/PULL_REQUEST_TEMPLATE.md" &&
      f.path !== "pull_request" &&
      f.path !== "projects/"
    ) {
      return { ok: false, reason: "path_outside_submission" };
    }
  }
  return { ok: true };
}

export function filterVerifiedFindings(
  findings: ReviewFinding[],
  packet: ReviewPacket,
): { kept: ReviewFinding[]; dropped: { finding: ReviewFinding; reason: FindingRejectReason }[] } {
  const kept: ReviewFinding[] = [];
  const dropped: { finding: ReviewFinding; reason: FindingRejectReason }[] = [];
  for (const f of findings) {
    const v = verifyFindingEvidence(f, packet);
    if (v.ok) kept.push(f);
    else dropped.push({ finding: f, reason: v.reason });
  }
  return { kept, dropped };
}
