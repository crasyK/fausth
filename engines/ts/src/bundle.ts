/**
 * Fausth harness bundle load / unpack (v0.1 + v0.2).
 *
 * v0.1: flat source archive (legacy).
 * v0.2: source files + verified top-level resolved IR for connector harnesses.
 */
import { createHash } from "node:crypto";
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
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson } from "./canonical.js";
import {
  RESOLVED_HARNESS_FORMAT,
  resolvedHarnessHash,
} from "./connectors/resolve.js";
import type { ResolvedHarnessIR } from "./types.js";

export const BUNDLE_FORMAT_V01 = "fausth-harness-bundle/v0.1" as const;
export const BUNDLE_FORMAT_V02 = "fausth-harness-bundle/v0.2" as const;
/** @deprecated Prefer BUNDLE_FORMAT_V01 — kept for existing callers. */
export const BUNDLE_FORMAT = BUNDLE_FORMAT_V01;
export const BUNDLE_MAX_FILES = 96;
export const BUNDLE_MAX_FILE_BYTES = 1_048_576;
export const BUNDLE_MAX_TOTAL_BYTES = 8_388_608;

export type HarnessBundleV1 = {
  format: typeof BUNDLE_FORMAT_V01;
  name: string;
  files: Record<string, string>;
};

export type HarnessBundleV2 = {
  format: typeof BUNDLE_FORMAT_V02;
  name: string;
  files: Record<string, string>;
  resolved: ResolvedHarnessIR;
  resolved_sha256: string;
};

export type HarnessBundle = HarnessBundleV1 | HarnessBundleV2;

export class BundleError extends Error {
  readonly code:
    | "bundle_invalid"
    | "bundle_path"
    | "bundle_too_large"
    | "bundle_unknown_entry"
    | "bundle_resolved_hash_mismatch"
    | "bundle_lock_file_missing"
    | "bundle_lock_hash_mismatch"
    | "not_found";
  constructor(code: BundleError["code"], message: string) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

const ALLOWED_FILE_RE_V01 =
  /^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml)$/;

const ALLOWED_FILE_RE_V02 =
  /^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml|connectors\.(yml|yaml|json)|connectors\/[A-Za-z0-9._-]+\.(yml|yaml|json))$/;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function isBundlePath(path: string): boolean {
  return path.endsWith(".fausth.json");
}

export function isHarnessBundleV2(bundle: HarnessBundle): bundle is HarnessBundleV2 {
  return bundle.format === BUNDLE_FORMAT_V02;
}

/** Reject traversal, absolute/drive paths, NULs; enforce version-specific allowlist. */
export function assertSafeBundleEntryName(
  name: string,
  format: typeof BUNDLE_FORMAT_V01 | typeof BUNDLE_FORMAT_V02 = BUNDLE_FORMAT_V01,
): void {
  if (!name || typeof name !== "string") {
    throw new BundleError("bundle_path", "empty bundle entry name");
  }
  if (name.includes("\0")) {
    throw new BundleError("bundle_path", "bundle entry contains NUL");
  }
  if (name.includes("\\")) {
    throw new BundleError("bundle_path", `backslash paths forbidden: ${name}`);
  }
  if (/^[a-zA-Z]:/.test(name) || name.startsWith("~") || name.startsWith("/")) {
    throw new BundleError("bundle_path", `absolute/drive bundle path: ${name}`);
  }
  const parts = name.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p === ".git")) {
    throw new BundleError("bundle_path", `unsafe bundle path: ${name}`);
  }
  if (format === BUNDLE_FORMAT_V01) {
    if (name.includes("/")) {
      throw new BundleError("bundle_path", `unsafe bundle path: ${name}`);
    }
    if (!ALLOWED_FILE_RE_V01.test(name)) {
      throw new BundleError("bundle_unknown_entry", `unknown or disallowed bundle entry: ${name}`);
    }
    return;
  }
  if (!ALLOWED_FILE_RE_V02.test(name)) {
    throw new BundleError("bundle_unknown_entry", `unknown or disallowed bundle entry: ${name}`);
  }
}

function validateFilesMap(
  filesRaw: unknown,
  format: typeof BUNDLE_FORMAT_V01 | typeof BUNDLE_FORMAT_V02,
): Record<string, string> {
  if (!filesRaw || typeof filesRaw !== "object" || Array.isArray(filesRaw)) {
    throw new BundleError("bundle_invalid", "bundle.files must be an object");
  }
  const files = filesRaw as Record<string, unknown>;
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
    assertSafeBundleEntryName(key, format);
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
  return out;
}

function validateResolvedObject(raw: unknown): ResolvedHarnessIR {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BundleError("bundle_invalid", "bundle.resolved must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== RESOLVED_HARNESS_FORMAT) {
    throw new BundleError(
      "bundle_invalid",
      `bundle.resolved.format must be ${RESOLVED_HARNESS_FORMAT}`,
    );
  }
  if (!obj.agent || typeof obj.agent !== "object" || Array.isArray(obj.agent)) {
    throw new BundleError("bundle_invalid", "bundle.resolved.agent must be an object");
  }
  if (!obj.resolution || typeof obj.resolution !== "object" || Array.isArray(obj.resolution)) {
    throw new BundleError("bundle_invalid", "bundle.resolved.resolution must be an object");
  }
  return raw as ResolvedHarnessIR;
}

/** Verify v0.2 resolved hash and file-connector lock pins against embedded files. */
export function verifyBundleIntegrity(bundle: HarnessBundleV2): void {
  const expected = resolvedHarnessHash(bundle.resolved);
  if (bundle.resolved_sha256 !== expected) {
    throw new BundleError(
      "bundle_resolved_hash_mismatch",
      `resolved_sha256 mismatch: expected ${expected}, got ${bundle.resolved_sha256}`,
    );
  }
  for (const lock of bundle.resolved.resolution.lock) {
    if (lock.kind === "inline") continue;
    if (lock.kind !== "file") {
      throw new BundleError(
        "bundle_invalid",
        `unsupported connector kind in resolved lock: ${String(lock.kind)}`,
      );
    }
    if (!lock.path) {
      throw new BundleError("bundle_lock_file_missing", "file lock entry missing path");
    }
    assertSafeBundleEntryName(lock.path, BUNDLE_FORMAT_V02);
    const content = bundle.files[lock.path];
    if (content === undefined) {
      throw new BundleError(
        "bundle_lock_file_missing",
        `lock path missing from bundle files: ${lock.path}`,
      );
    }
    const digest = sha256Hex(content);
    if (digest !== lock.sha256) {
      throw new BundleError(
        "bundle_lock_hash_mismatch",
        `sha256 mismatch for ${lock.path}: expected ${lock.sha256}, got ${digest}`,
      );
    }
  }
}

export function validateBundle(raw: unknown): HarnessBundle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BundleError("bundle_invalid", "bundle must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const format = obj.format;
  if (format !== BUNDLE_FORMAT_V01 && format !== BUNDLE_FORMAT_V02) {
    throw new BundleError(
      "bundle_invalid",
      `expected format ${BUNDLE_FORMAT_V01} or ${BUNDLE_FORMAT_V02}, got ${String(format)}`,
    );
  }
  if (typeof obj.name !== "string" || !obj.name) {
    throw new BundleError("bundle_invalid", "bundle.name must be a non-empty string");
  }
  if (!NAME_RE.test(obj.name)) {
    throw new BundleError("bundle_invalid", "bundle.name has invalid characters");
  }
  const files = validateFilesMap(obj.files, format);

  if (format === BUNDLE_FORMAT_V01) {
    if ("resolved" in obj || "resolved_sha256" in obj) {
      throw new BundleError("bundle_invalid", "v0.1 bundle must not include resolved fields");
    }
    return { format: BUNDLE_FORMAT_V01, name: obj.name, files };
  }

  if (typeof obj.resolved_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(obj.resolved_sha256)) {
    throw new BundleError(
      "bundle_invalid",
      "bundle.resolved_sha256 must be a 64-char lowercase hex string",
    );
  }
  const resolved = validateResolvedObject(obj.resolved);
  const bundle: HarnessBundleV2 = {
    format: BUNDLE_FORMAT_V02,
    name: obj.name,
    files,
    resolved,
    resolved_sha256: obj.resolved_sha256,
  };
  verifyBundleIntegrity(bundle);
  return bundle;
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
 * Creates nested parent dirs for v0.2 connector paths. Does not write embedded resolved IR.
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
  for (const name of Object.keys(b.files)) {
    assertSafeBundleEntryName(name, b.format);
  }
  for (const [name, content] of Object.entries(b.files)) {
    const target = join(dest, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
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
  /** Bundle format when kind=bundle. */
  bundleFormat?: typeof BUNDLE_FORMAT_V01 | typeof BUNDLE_FORMAT_V02;
  /**
   * Verified embedded resolved IR from a v0.2 bundle.
   * Authoritative for bundle execution; not written into the unpacked source tree.
   */
  embeddedResolved?: ResolvedHarnessIR;
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
    const loaded = loadBundleFile(abs);
    const tmp = mkdtempSync(join(tmpdir(), "fausth-bundle-"));
    unpackBundle(loaded, tmp, { force: true });
    return {
      kind: "bundle",
      harnessDir: tmp,
      cleanup: () => {
        rmSync(tmp, { recursive: true, force: true });
      },
      source: abs,
      bundleFormat: loaded.format,
      embeddedResolved: isHarnessBundleV2(loaded) ? loaded.resolved : undefined,
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

export function bundleCanonicalJson(bundle: HarnessBundle): string {
  return canonicalJson(bundle) + "\n";
}
