/**
 * Build a ReviewPacket from a local checkout diff or GitHub PR via `gh`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  runSubmissionCheck,
  type ReviewPacket,
  type SubmissionCheckInput,
} from "./submission-check.js";

function ghJson(args: string[]): unknown {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(out);
}

function collectFilesFromDir(root: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) Object.assign(out, collectFilesFromDir(full, rel));
    else if (st.isFile() && st.size < 200_000) {
      try {
        out[rel.replace(/\\/g, "/")] = readFileSync(full, "utf8");
      } catch {
        /* skip binary */
      }
    }
  }
  return out;
}

/** Build packet from an already-materialized SubmissionCheckInput. */
export function packetFromInput(input: SubmissionCheckInput): ReviewPacket {
  return runSubmissionCheck(input);
}

/** `owner/name` GitHub slug with safe characters only (no `?`, `#`, `..`, extra `/`). */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function assertSafeRepo(repo: string): void {
  if (typeof repo !== "string" || !REPO_RE.test(repo) || repo.split("/")[1] === "." || repo.split("/")[1] === "..") {
    throw new Error(`invalid repo slug (expected owner/name): ${JSON.stringify(repo)}`);
  }
}

function assertPrNumber(pr: number): void {
  if (!Number.isInteger(pr) || pr < 1) {
    throw new Error(`invalid PR number: ${String(pr)}`);
  }
}

/**
 * `gh api` path for a file at the PR head. Every path segment is percent-encoded, so an
 * untrusted PR filename containing `?`, `#`, `%` or `&` cannot change the endpoint or the
 * `ref` query; traversal / empty segments are rejected.
 */
export function contentsApiPath(repo: string, path: string, pr: number): string {
  assertSafeRepo(repo);
  assertPrNumber(pr);
  const segments = String(path ?? "").split("/");
  if (
    segments.length === 0 ||
    segments.some((seg) => seg === "" || seg === "." || seg === ".." || seg.includes("\0"))
  ) {
    throw new Error(`unsafe PR file path: ${JSON.stringify(path)}`);
  }
  const encoded = segments.map((seg) => encodeURIComponent(seg)).join("/");
  return `repos/${repo}/contents/${encoded}?ref=refs/pull/${pr}/head`;
}

/** Decoded file content at the PR head, or null when missing/unreadable. */
function fetchPrFile(repo: string, path: string, pr: number): string | null {
  let apiPath: string;
  try {
    apiPath = contentsApiPath(repo, path, pr);
  } catch {
    return null; // unsafe name → treated as missing (deterministic checks still see the path)
  }
  try {
    const content = execFileSync("gh", ["api", apiPath, "--jq", ".content"], {
      encoding: "utf8",
    }).trim();
    if (!content || content === "null") return null;
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch {
    return null; // missing file → deterministic fail where it matters
  }
}

/**
 * Fetch PR metadata + changed files via GitHub CLI and build a packet.
 * Requires `gh` auth (GH_TOKEN or gh auth login).
 */
export function packetFromGithubPr(repo: string, pr: number): ReviewPacket {
  assertSafeRepo(repo);
  assertPrNumber(pr);
  const meta = ghJson([
    "pr",
    "view",
    String(pr),
    "--repo",
    repo,
    "--json",
    "title,body,files",
  ]) as {
    title: string;
    body: string;
    files: { path: string }[];
  };

  const changed_paths = (meta.files ?? []).map((f) => f.path);
  const file_contents: Record<string, string> = {};

  for (const path of changed_paths) {
    if (/\.(png|jpe?g|gif|webp|zip|exe)$/i.test(path)) continue;
    const content = fetchPrFile(repo, path, pr);
    if (content !== null) file_contents[path] = content;
  }

  // Also try to load README for project folders even if not in files list somehow
  const folders = new Set<string>();
  for (const p of changed_paths) {
    const m = p.match(/^projects\/([^/]+)\//);
    if (m) folders.add(m[1]!);
  }
  for (const folder of folders) {
    const readme = `projects/${folder}/README.md`;
    if (file_contents[readme]) continue;
    const content = fetchPrFile(repo, readme, pr);
    if (content !== null) file_contents[readme] = content;
  }

  const packet = runSubmissionCheck({
    pr_title: meta.title,
    pr_body: meta.body ?? "",
    changed_paths,
    file_contents,
  });
  packet.repo = repo;
  packet.pr_number = pr;
  return packet;
}

/** Build packet from a local synthetic fixture directory (testdata). */
export function packetFromFixtureDir(dir: string): ReviewPacket {
  const metaPath = join(dir, "pr.json");
  const meta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as {
        title?: string;
        body?: string;
        changed_paths?: string[];
      })
    : {};
  const filesRoot = join(dir, "files");
  const file_contents = collectFilesFromDir(filesRoot);
  const changed_paths =
    meta.changed_paths ??
    Object.keys(file_contents).map((p) => p); // paths already relative under files/

  // If files are stored as files/projects/..., keep those paths
  return runSubmissionCheck({
    pr_title: meta.title,
    pr_body: meta.body ?? "",
    changed_paths,
    file_contents,
  });
}
