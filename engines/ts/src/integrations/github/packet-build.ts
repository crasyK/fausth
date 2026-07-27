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

/**
 * Fetch PR metadata + changed files via GitHub CLI and build a packet.
 * Requires `gh` auth (GH_TOKEN or gh auth login).
 */
export function packetFromGithubPr(repo: string, pr: number): ReviewPacket {
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
    try {
      // Prefer file at PR head
      const content = execFileSync(
        "gh",
        ["api", `repos/${repo}/contents/${path}?ref=refs/pull/${pr}/head`, "--jq", ".content"],
        { encoding: "utf8" },
      ).trim();
      if (content && content !== "null") {
        file_contents[path] = Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
      }
    } catch {
      // fallback: raw.githubusercontent via gh api raw
      try {
        const raw = execFileSync(
          "gh",
          ["api", `repos/${repo}/contents/${encodeURIComponent(path)}`, "--jq", ".download_url"],
          { encoding: "utf8" },
        ).trim();
        if (raw && raw !== "null") {
          // skip network fetch if complicated — leave missing for deterministic fail
        }
      } catch {
        /* missing file */
      }
    }
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
    try {
      const content = execFileSync(
        "gh",
        ["api", `repos/${repo}/contents/${readme}?ref=refs/pull/${pr}/head`, "--jq", ".content"],
        { encoding: "utf8" },
      ).trim();
      if (content && content !== "null") {
        file_contents[readme] = Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
      }
    } catch {
      /* missing */
    }
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
