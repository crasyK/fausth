/**
 * Fausth harness bundle load / unpack (fausth-harness-bundle/v0.1).
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const BUNDLE_FORMAT = "fausth-harness-bundle/v0.1";
export const BUNDLE_MAX_FILES = 64;
export const BUNDLE_MAX_FILE_BYTES = 1_048_576;
export const BUNDLE_MAX_TOTAL_BYTES = 8_388_608;

export type HarnessBundle = {
  format: typeof BUNDLE_FORMAT;
  name: string;
  files: Record<string, string>;
};

export class BundleError extends Error {
  readonly code:
    | "bundle_invalid"
    | "bundle_path"
    | "bundle_too_large"
    | "bundle_unknown_entry"
    | "not_found";
  constructor(code: BundleError["code"], message: string) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

const ALLOWED_FILE_RE =
  /^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml)$/;

export function isBundlePath(path: string): boolean {
  return path.endsWith(".fausth.json");
}

/** Reject traversal, separators, absolute/drive paths, NULs. */
export function assertSafeBundleEntryName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new BundleError("bundle_path", "empty bundle entry name");
  }
  if (name.includes("\0")) {
    throw new BundleError("bundle_path", "bundle entry contains NUL");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new BundleError("bundle_path", `unsafe bundle path: ${name}`);
  }
  if (/^[a-zA-Z]:/.test(name) || name.startsWith("~")) {
    throw new BundleError("bundle_path", `absolute/drive bundle path: ${name}`);
  }
  if (!ALLOWED_FILE_RE.test(name)) {
    throw new BundleError("bundle_unknown_entry", `unknown or disallowed bundle entry: ${name}`);
  }
}

export function validateBundle(raw: unknown): HarnessBundle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BundleError("bundle_invalid", "bundle must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== BUNDLE_FORMAT) {
    throw new BundleError(
      "bundle_invalid",
      `expected format ${BUNDLE_FORMAT}, got ${String(obj.format)}`,
    );
  }
  if (typeof obj.name !== "string" || !obj.name) {
    throw new BundleError("bundle_invalid", "bundle.name must be a non-empty string");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(obj.name)) {
    throw new BundleError("bundle_invalid", "bundle.name has invalid characters");
  }
  if (!obj.files || typeof obj.files !== "object" || Array.isArray(obj.files)) {
    throw new BundleError("bundle_invalid", "bundle.files must be an object");
  }
  const files = obj.files as Record<string, unknown>;
  const keys = Object.keys(files);
  if (keys.length === 0) {
    throw new BundleError("bundle_invalid", "bundle.files is empty");
  }
  if (keys.length > BUNDLE_MAX_FILES) {
    throw new BundleError("bundle_too_large", `too many files (max ${BUNDLE_MAX_FILES})`);
  }
  let total = 0;
  const out: Record<string, string> = {};
  for (const key of keys.sort()) {
    assertSafeBundleEntryName(key);
    const content = files[key];
    if (typeof content !== "string") {
      throw new BundleError("bundle_invalid", `file content must be UTF-8 string: ${key}`);
    }
    if (content.includes("\0")) {
      throw new BundleError("bundle_invalid", `NUL in file content: ${key}`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > BUNDLE_MAX_FILE_BYTES) {
      throw new BundleError("bundle_too_large", `file too large: ${key}`);
    }
    total += bytes;
    out[key] = content;
  }
  if (total > BUNDLE_MAX_TOTAL_BYTES) {
    throw new BundleError("bundle_too_large", "bundle total size exceeds limit");
  }
  const hasAgent = keys.some((k) => k === "agent.yml" || k === "agent.yaml" || k === "agent.json");
  if (!hasAgent) {
    throw new BundleError("bundle_invalid", "bundle requires agent.yml, agent.yaml, or agent.json");
  }
  return { format: BUNDLE_FORMAT, name: obj.name, files: out };
}

export function loadBundleFile(path: string): HarnessBundle {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new BundleError("not_found", `bundle not found: ${abs}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new BundleError("bundle_invalid", `invalid JSON: ${e instanceof Error ? e.message : e}`);
  }
  return validateBundle(parsed);
}

/**
 * Unpack a validated bundle into outDir. Refuses to write until validation succeeds.
 * Creates outDir if needed; with force, allows non-empty dirs.
 */
export function unpackBundle(
  bundle: HarnessBundle | string,
  outDir: string,
  opts: { force?: boolean } = {},
): string {
  const b = typeof bundle === "string" ? loadBundleFile(bundle) : validateBundle(bundle);
  const dest = resolve(outDir);
  if (existsSync(dest)) {
    const ents = readdirSync(dest);
    if (ents.length && !opts.force) {
      throw new BundleError("bundle_invalid", `output directory not empty: ${dest} (pass --force)`);
    }
  } else {
    mkdirSync(dest, { recursive: true });
  }
  // Validate all names again before any write
  for (const name of Object.keys(b.files)) {
    assertSafeBundleEntryName(name);
  }
  for (const [name, content] of Object.entries(b.files)) {
    writeFileSync(join(dest, name), content, "utf8");
  }
  return dest;
}

export type ResolvedHarness = {
  kind: "dir" | "bundle";
  /** Directory containing agent.yml / agent.json (temp dir when kind=bundle). */
  harnessDir: string;
  /** Cleanup temp dir if created from a bundle. */
  cleanup: () => void;
  source: string;
};

/**
 * Resolve a harness directory or `.fausth.json` bundle to a usable harness directory.
 * Bundle contents are unpacked to a temporary directory.
 */
export function resolveHarnessRef(ref: string): ResolvedHarness {
  const abs = resolve(ref);
  if (!existsSync(abs)) {
    throw new BundleError("not_found", `harness not found: ${abs}`);
  }
  const st = statSync(abs);
  if (st.isDirectory()) {
    return {
      kind: "dir",
      harnessDir: abs,
      cleanup: () => {},
      source: abs,
    };
  }
  if (st.isFile() && isBundlePath(abs)) {
    const tmp = mkdtempSync(join(tmpdir(), "fausth-bundle-"));
    unpackBundle(abs, tmp, { force: true });
    return {
      kind: "bundle",
      harnessDir: tmp,
      cleanup: () => {
        rmSync(tmp, { recursive: true, force: true });
      },
      source: abs,
    };
  }
  throw new BundleError(
    "bundle_invalid",
    `expected harness directory or .fausth.json bundle, got: ${basename(abs)}`,
  );
}

/** Run fn with a resolved harness ref and always cleanup. */
export async function withHarnessRef<T>(
  ref: string,
  fn: (harnessDir: string, resolved: ResolvedHarness) => Promise<T> | T,
): Promise<T> {
  const resolved = resolveHarnessRef(ref);
  try {
    return await fn(resolved.harnessDir, resolved);
  } finally {
    resolved.cleanup();
  }
}
