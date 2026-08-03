/**
 * Extract repo-relative source paths from SWE plan text / approve events.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const PATH_RE =
  /(?:^|[\s`'"(,])([a-zA-Z0-9][a-zA-Z0-9_./-]*\.(?:py|pyi|js|ts|tsx|jsx|java|go|rs|c|h|cpp|hpp|yml|yaml|toml|json))(?:[\s`'"),.:]|$)/gm;

const TEST_PATH_RE = /^(?:tests?\/|test_)/i;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractPlanPaths(text) {
  if (!text || typeof text !== "string") return [];
  const found = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    const p = String(m[1] ?? "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (!p || TEST_PATH_RE.test(p)) continue;
    if (p.includes("..")) continue;
    found.add(p);
  }
  return [...found].sort();
}

/**
 * @param {string} eventsText
 * @returns {string[]}
 */
export function extractApprovedPathsFromEvents(eventsText) {
  const paths = new Set();
  for (const line of eventsText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.tool !== "user.approve") continue;
      const plan =
        e.args?.plan ??
        e.args?.request ??
        (typeof e.args?.message === "string" ? e.args.message : "");
      for (const p of extractPlanPaths(String(plan ?? ""))) paths.add(p);
      // Also scan propose-stage plan text when present
      if (e.stage === "propose" && e.args) {
        for (const p of extractPlanPaths(JSON.stringify(e.args))) paths.add(p);
      }
    } catch {
      /* skip */
    }
  }
  return [...paths].sort();
}

/**
 * @param {string} worktree
 * @param {string[]} paths
 */
export function writeApprovedPathsFile(worktree, paths) {
  if (!paths.length) return;
  const dir = join(worktree, ".fausth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "approved_paths.json"),
    JSON.stringify({ paths, written_at: new Date().toISOString() }, null, 2) + "\n",
  );
}
