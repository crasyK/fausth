/**
 * Extract repo-relative source paths from SWE plan / approve text.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PATH_RE =
  /(?:^|[\s`'"(,])([a-zA-Z0-9][a-zA-Z0-9_./-]*\.(?:py|pyi|js|ts|tsx|jsx|java|go|rs|c|h|cpp|hpp|yml|yaml|toml|json))(?:[\s`'"),.:]|$)/gm;

const TEST_PATH_RE = /^(?:tests?\/|test_)/i;

export function extractPlanPaths(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
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

export function loadApprovedWritePaths(worktreeRoot: string): string[] | null {
  try {
    const p = join(worktreeRoot, ".fausth", "approved_paths.json");
    if (!existsSync(p)) return null;
    const doc = JSON.parse(readFileSync(p, "utf8")) as { paths?: unknown };
    if (!Array.isArray(doc.paths)) return null;
    return doc.paths.map((x) => String(x).replace(/\\/g, "/"));
  } catch {
    return null;
  }
}
