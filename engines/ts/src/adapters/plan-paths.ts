/**
 * Extract repo-relative source paths from SWE plan / approve text, and read the host's
 * approved-path record.
 *
 * `.fausth/` is a host control directory: the local adapter never lets the agent write it
 * (through any alias), and the record is read once when the world is created — before the
 * agent acts — so mid-run changes (e.g. by agent-written test code) cannot widen the plan.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeToolPath, ROOT_SCOPE } from "./sandbox-path.js";

const PATH_RE =
  /(?:^|[\s`'"(,])([a-zA-Z0-9][a-zA-Z0-9_./-]*\.(?:py|pyi|js|ts|tsx|jsx|java|go|rs|c|h|cpp|hpp|yml|yaml|toml|json))(?:[\s`'"),.:]|$)/gm;

const TEST_PATH_RE = /^(?:tests?\/|test_)/i;

export function extractPlanPaths(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const raw = String(m[1] ?? "");
    let p: string;
    try {
      p = normalizeToolPath(raw);
    } catch {
      continue; // '..', absolute, .git → never an approvable path
    }
    if (p === ROOT_SCOPE || TEST_PATH_RE.test(p)) continue;
    found.add(p);
  }
  return [...found].sort();
}

/** Host record `.fausth/approved_paths.json` → normalized paths (invalid entries dropped). */
export function loadApprovedWritePaths(worktreeRoot: string): string[] | null {
  try {
    const p = join(worktreeRoot, ".fausth", "approved_paths.json");
    if (!existsSync(p)) return null;
    const doc = JSON.parse(readFileSync(p, "utf8")) as { paths?: unknown };
    if (!Array.isArray(doc.paths)) return null;
    const out: string[] = [];
    for (const x of doc.paths) {
      try {
        const n = normalizeToolPath(String(x));
        if (n !== ROOT_SCOPE) out.push(n);
      } catch {
        /* skip invalid entry */
      }
    }
    return out;
  } catch {
    return null;
  }
}
