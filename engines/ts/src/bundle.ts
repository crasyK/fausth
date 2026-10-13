/**
 * Fausth harness bundle load / unpack / verify (v0.1 + v0.2 + v0.3).
 *
 * v0.1: flat source archive (legacy).
 * v0.2: source files + verified top-level resolved IR for connector harnesses.
 * v0.3: v0.2 plus MCP descriptors / module manifests and their recorded fixtures.
 *
 * Trust model:
 * - A signature proves only "signed by the key embedded in the bundle". Trust comes from
 *   an operator trust store (FAUSTH_TRUSTED_KEYS / `trustedKeys`), giving three outcomes:
 *   unsigned | signed-untrusted | signed-trusted.
 * - `requireTrusted` (FAUSTH_REQUIRE_TRUSTED_BUNDLES=1) rejects everything but signed-trusted.
 * - The embedded `resolved` IR is executed for v0.2+/v0.3 bundles, so it must equal the
 *   re-resolution of the shipped source files (no "shows harmless agent.yml, runs
 *   something else"); `resolved_sha256` is therefore checked against the sources, not
 *   only against the embedded object.
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
  type BundleSignature,
  type BundleTrust,
  BundleSignatureError,
  classifyBundleTrust,
  loadTrustStore,
  requireTrustedFromEnv,
  type TrustStore,
  trustStoreFromEnv,
} from "./bundle-signature.js";
import {
  RESOLVED_HARNESS_FORMAT,
  resolveHarness,
  resolvedHarnessHash,
} from "./connectors/resolve.js";
import { registerBundleDir, unregisterBundleDir } from "./adapters/provenance.js";
import { INT53_MAX, INT53_MIN, type ResolvedHarnessIR } from "./types.js";

export type { BundleTrust, TrustStore } from "./bundle-signature.js";

export const BUNDLE_FORMAT_V01 = "fausth-harness-bundle/v0.1" as const;
export const BUNDLE_FORMAT_V02 = "fausth-harness-bundle/v0.2" as const;
export const BUNDLE_FORMAT_V03 = "fausth-harness-bundle/v0.3" as const;
/** @deprecated Prefer BUNDLE_FORMAT_V01 — kept for existing callers. */
export const BUNDLE_FORMAT = BUNDLE_FORMAT_V01;
export const BUNDLE_MAX_FILES = 96;
export const BUNDLE_MAX_FILE_BYTES = 1_048_576;
export const BUNDLE_MAX_TOTAL_BYTES = 8_388_608;
/** Matches `propertyNames.maxLength` in the bundle schemas. */
export const BUNDLE_MAX_ENTRY_NAME = 200;

export type BundleFormatResolved =
  | typeof BUNDLE_FORMAT_V02
  | typeof BUNDLE_FORMAT_V03;

export type HarnessBundleV1 = {
  format: typeof BUNDLE_FORMAT_V01;
  name: string;
  files: Record<string, string>;
  signature?: BundleSignature;
};

export type HarnessBundleV2 = {
  format: BundleFormatResolved;
  name: string;
  files: Record<string, string>;
  resolved: ResolvedHarnessIR;
  resolved_sha256: string;
  signature?: BundleSignature;
};

export type HarnessBundle = HarnessBundleV1 | HarnessBundleV2;

/** Closed set of bundle failure codes. */
export type BundleErrorCode =
  | "bundle_invalid"
  | "bundle_path"
  | "bundle_too_large"
  | "bundle_unknown_entry"
  | "bundle_resolved_hash_mismatch"
  | "bundle_resolved_mismatch"
  | "bundle_lock_file_missing"
  | "bundle_lock_hash_mismatch"
  | "bundle_signature_invalid"
  | "bundle_signature_unsupported"
  | "bundle_signature_untrusted"
  | "bundle_unsigned"
  | "bundle_trust_store_invalid"
  | "not_found";

export class BundleError extends Error {
  readonly code: BundleErrorCode;
  constructor(code: BundleErrorCode, message: string) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

/** Codes that mean "intact bundle, rejected by the operator's trust policy". */
const POLICY_CODES = new Set<BundleErrorCode>(["bundle_unsigned", "bundle_signature_untrusted"]);

export type BundleLoadOptions = {
  /** Trusted-keys file path, or a parsed store. Default: env FAUSTH_TRUSTED_KEYS. */
  trustedKeys?: string | TrustStore;
  /** Accept only signed-trusted bundles. Default: env FAUSTH_REQUIRE_TRUSTED_BUNDLES. */
  requireTrusted?: boolean;
};

export type VerifiedBundle = { bundle: HarnessBundle; trust: BundleTrust };

const ALLOWED_FILE_RE_V01 =
  /^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml)$/;

const ALLOWED_FILE_RE_V02 =
  /^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml|connectors\.(yml|yaml|json)|connectors\/[A-Za-z0-9._-]+\.(yml|yaml|json))$/;

/** Must stay identical to schema/fausth-harness-bundle.v0.3.json `propertyNames.pattern`. */
export const ALLOWED_FILE_RE_V03 =
  /^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|mcp\.recorded\.jsonl|module\.recorded\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml|connectors\.(yml|yaml|json)|connectors\/[A-Za-z0-9._-]+\.(yml|yaml|json)|connectors\/mcp\/[A-Za-z0-9._-]+\.json|connectors\/module\/[A-Za-z0-9._-]+\.(json|yml|yaml|mjs))$/;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Top-level keys allowed by the bundle schemas (additionalProperties: false). */
const TOP_LEVEL_V01 = new Set(["format", "name", "files", "signature"]);
const TOP_LEVEL_V02 = new Set(["format", "name", "files", "resolved", "resolved_sha256", "signature"]);

/** Lock kinds whose pinned artifact ships as a bundle file. */
const FILE_BACKED_LOCK_KINDS = new Set(["file", "mcp", "module"]);

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** D3 at the bundle entry: every JSON number must be an int53 integer (no crash later). */
function assertCanonicalNumbers(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new BundleError("bundle_invalid", `non-canonical (non-integral) number at ${path}`);
    }
    if (value < INT53_MIN || value > INT53_MAX) {
      throw new BundleError("bundle_invalid", `integer out of portable int53 range at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCanonicalNumbers(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertCanonicalNumbers(v, `${path}.${k}`);
    }
  }
}

export function isBundlePath(path: string): boolean {
  return path.endsWith(".fausth.json");
}

export function isHarnessBundleV2(bundle: HarnessBundle): bundle is HarnessBundleV2 {
  return bundle.format === BUNDLE_FORMAT_V02 || bundle.format === BUNDLE_FORMAT_V03;
}

type AnyBundleFormat =
  | typeof BUNDLE_FORMAT_V01
  | typeof BUNDLE_FORMAT_V02
  | typeof BUNDLE_FORMAT_V03;

/** Reject traversal, absolute/drive paths, NULs; enforce version-specific allowlist. */
export function assertSafeBundleEntryName(
  name: string,
  format: AnyBundleFormat = BUNDLE_FORMAT_V01,
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
  if (name.length > BUNDLE_MAX_ENTRY_NAME) {
    throw new BundleError("bundle_path", `bundle entry name too long: ${name.slice(0, 64)}…`);
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
  if (format === BUNDLE_FORMAT_V02) {
    if (!ALLOWED_FILE_RE_V02.test(name)) {
      throw new BundleError("bundle_unknown_entry", `unknown or disallowed bundle entry: ${name}`);
    }
    return;
  }
  if (format === BUNDLE_FORMAT_V03) {
    if (!ALLOWED_FILE_RE_V03.test(name)) {
      throw new BundleError("bundle_unknown_entry", `unknown or disallowed bundle entry: ${name}`);
    }
    return;
  }
  throw new BundleError("bundle_invalid", `unknown bundle format for path check: ${String(format)}`);
}

function validateFilesMap(
  filesRaw: unknown,
  format: AnyBundleFormat,
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
    if (LONE_SURROGATE_RE.test(content)) {
      throw new BundleError("bundle_invalid", `file content is not well-formed Unicode: ${key}`);
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
  const resolution = obj.resolution as Record<string, unknown>;
  if (!Array.isArray(resolution.lock)) {
    throw new BundleError("bundle_invalid", "bundle.resolved.resolution.lock must be an array");
  }
  return raw as ResolvedHarnessIR;
}

/** Verify resolved hash and file/mcp/module lock pins against embedded files. */
export function verifyBundleIntegrity(bundle: HarnessBundleV2): void {
  const expected = resolvedHarnessHash(bundle.resolved);
  if (bundle.resolved_sha256 !== expected) {
    throw new BundleError(
      "bundle_resolved_hash_mismatch",
      `resolved_sha256 mismatch: expected ${expected}, got ${bundle.resolved_sha256}`,
    );
  }
  for (const lock of bundle.resolved.resolution.lock) {
    if (!lock || typeof lock !== "object") {
      throw new BundleError("bundle_invalid", "resolved lock entry must be an object");
    }
    if (lock.kind === "inline") continue;
    if (!FILE_BACKED_LOCK_KINDS.has(lock.kind)) {
      throw new BundleError(
        "bundle_invalid",
        `unsupported connector kind in resolved lock: ${String(lock.kind)}`,
      );
    }
    if (!lock.path) {
      throw new BundleError("bundle_lock_file_missing", `${lock.kind} lock entry missing path`);
    }
    assertSafeBundleEntryName(lock.path, bundle.format);
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

/** Write already-validated bundle files under dest (dest must exist). */
function writeBundleFiles(b: HarnessBundle, dest: string): void {
  for (const name of Object.keys(b.files)) {
    assertSafeBundleEntryName(name, b.format);
  }
  for (const [name, content] of Object.entries(b.files)) {
    const target = join(dest, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/**
 * Re-resolve the shipped source files in a private temp dir and require the result to equal
 * the embedded resolved IR. The embedded IR is what executes, so it must be exactly what the
 * shipped agent.yml / connectors resolve to.
 */
export function verifyResolvedMatchesSources(bundle: HarnessBundleV2): void {
  const tmp = mkdtempSync(join(tmpdir(), "fausth-reresolve-"));
  try {
    writeBundleFiles(bundle, tmp);
    let fromSources: string;
    try {
      fromSources = resolvedHarnessHash(resolveHarness(tmp));
    } catch (e) {
      throw new BundleError(
        "bundle_resolved_mismatch",
        `shipped sources do not resolve: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (fromSources !== bundle.resolved_sha256) {
      throw new BundleError(
        "bundle_resolved_mismatch",
        `embedded resolved IR does not match the shipped sources: sources resolve to ${fromSources}, bundle declares ${bundle.resolved_sha256}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function resolveTrustStore(opts: BundleLoadOptions): TrustStore | undefined {
  try {
    if (opts.trustedKeys === undefined) return trustStoreFromEnv();
    if (typeof opts.trustedKeys === "string") return loadTrustStore(opts.trustedKeys);
    return opts.trustedKeys;
  } catch (e) {
    if (e instanceof BundleSignatureError) {
      throw new BundleError("bundle_trust_store_invalid", e.message);
    }
    throw e;
  }
}

function requireTrustedOf(opts: BundleLoadOptions): boolean {
  return opts.requireTrusted ?? requireTrustedFromEnv();
}

function classifyOrThrow(obj: Record<string, unknown>, store: TrustStore | undefined): BundleTrust {
  try {
    return classifyBundleTrust(obj, store);
  } catch (e) {
    if (e instanceof BundleSignatureError) {
      throw new BundleError(
        e.code === "bundle_signature_unsupported"
          ? "bundle_signature_unsupported"
          : "bundle_signature_invalid",
        e.message,
      );
    }
    throw e;
  }
}

function enforceTrustPolicy(trust: BundleTrust, requireTrusted: boolean): void {
  if (!requireTrusted || trust.status === "signed-trusted") return;
  if (trust.status === "unsigned") {
    throw new BundleError(
      "bundle_unsigned",
      "unsigned bundle rejected: trusted signature required (FAUSTH_REQUIRE_TRUSTED_BUNDLES / requireTrusted)",
    );
  }
  throw new BundleError(
    "bundle_signature_untrusted",
    `bundle signed by untrusted key ${trust.public_key}: not in the trusted keys store`,
  );
}

/**
 * Structural + cryptographic + integrity verification of a raw bundle object.
 * Order: shape → signature (tamper) → integrity pins → source re-resolution → trust policy,
 * so an intact-but-untrusted bundle is distinguishable from a broken one.
 */
function verifyBundleObject(
  raw: unknown,
  opts: BundleLoadOptions,
  enforcePolicy: boolean,
): VerifiedBundle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BundleError("bundle_invalid", "bundle must be an object");
  }
  const obj = raw as Record<string, unknown>;
  assertCanonicalNumbers(obj);
  const format = obj.format;
  if (
    format !== BUNDLE_FORMAT_V01 &&
    format !== BUNDLE_FORMAT_V02 &&
    format !== BUNDLE_FORMAT_V03
  ) {
    throw new BundleError(
      "bundle_invalid",
      `expected format ${BUNDLE_FORMAT_V01}, ${BUNDLE_FORMAT_V02}, or ${BUNDLE_FORMAT_V03}, got ${String(format)}`,
    );
  }
  const allowedTop = format === BUNDLE_FORMAT_V01 ? TOP_LEVEL_V01 : TOP_LEVEL_V02;
  for (const k of Object.keys(obj)) {
    if (!allowedTop.has(k)) {
      if (format === BUNDLE_FORMAT_V01 && (k === "resolved" || k === "resolved_sha256")) {
        throw new BundleError("bundle_invalid", "v0.1 bundle must not include resolved fields");
      }
      throw new BundleError("bundle_invalid", `unknown top-level bundle field: ${k}`);
    }
  }
  if (typeof obj.name !== "string" || !obj.name) {
    throw new BundleError("bundle_invalid", "bundle.name must be a non-empty string");
  }
  if (!NAME_RE.test(obj.name)) {
    throw new BundleError("bundle_invalid", "bundle.name has invalid characters");
  }
  const files = validateFilesMap(obj.files, format);
  const store = resolveTrustStore(opts);

  let bundle: HarnessBundle;
  if (format === BUNDLE_FORMAT_V01) {
    bundle = { format: BUNDLE_FORMAT_V01, name: obj.name, files };
  } else {
    if (typeof obj.resolved_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(obj.resolved_sha256)) {
      throw new BundleError(
        "bundle_invalid",
        "bundle.resolved_sha256 must be a 64-char lowercase hex string",
      );
    }
    const resolved = validateResolvedObject(obj.resolved);
    bundle = {
      format,
      name: obj.name,
      files,
      resolved,
      resolved_sha256: obj.resolved_sha256,
    };
  }

  // Signature first (covers files + resolved): a tampered signed bundle is always invalid.
  const trust = classifyOrThrow(obj, store);
  if (trust.status !== "unsigned") {
    bundle = { ...bundle, signature: obj.signature as BundleSignature };
  }
  if (isHarnessBundleV2(bundle)) {
    verifyBundleIntegrity(bundle);
    verifyResolvedMatchesSources(bundle);
  }
  if (enforcePolicy) enforceTrustPolicy(trust, requireTrustedOf(opts));
  return { bundle, trust };
}

/** Validate a bundle object (signature, integrity, re-resolution, trust policy). */
export function validateBundle(raw: unknown, opts: BundleLoadOptions = {}): HarnessBundle {
  return verifyBundleObject(raw, opts, true).bundle;
}

/** Like validateBundle but also returns the trust classification. */
export function verifyBundle(raw: unknown, opts: BundleLoadOptions = {}): VerifiedBundle {
  return verifyBundleObject(raw, opts, true);
}

/**
 * Pack-side self check: the exact loader rules minus the trust policy (packing an unsigned
 * bundle is fine). Guarantees pack never emits a bundle the loader rejects.
 */
export function assertLoadableBundle(raw: unknown): void {
  verifyBundleObject(raw, {}, false);
}

function readBundleJson(path: string): unknown {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new BundleError("not_found", `bundle not found: ${abs}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(abs));
  } catch {
    throw new BundleError("bundle_invalid", `bundle is not valid UTF-8: ${abs}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BundleError("bundle_invalid", `invalid JSON: ${e instanceof Error ? e.message : e}`);
  }
}

export function loadVerifiedBundleFile(path: string, opts: BundleLoadOptions = {}): VerifiedBundle {
  return verifyBundleObject(readBundleJson(path), opts, true);
}

export function loadBundleFile(path: string, opts: BundleLoadOptions = {}): HarnessBundle {
  return loadVerifiedBundleFile(path, opts).bundle;
}

/** CLI-facing verification report (never throws for bundle problems). */
export type BundleVerifyReport = {
  ok: boolean;
  /**
   * 0 = accepted; 1 = invalid / tampered / unreadable bundle;
   * 2 = trust-store configuration error; 3 = intact bundle rejected by trust policy.
   */
  exit_code: 0 | 1 | 2 | 3;
  path: string;
  format?: string;
  status?: BundleTrust["status"];
  public_key?: string;
  key_label?: string;
  require_trusted: boolean;
  error?: { code: BundleErrorCode; message: string };
};

export function verifyBundleFile(path: string, opts: BundleLoadOptions = {}): BundleVerifyReport {
  const abs = resolve(path);
  const requireTrusted = requireTrustedOf(opts);
  let verified: VerifiedBundle;
  try {
    verified = verifyBundleObject(readBundleJson(abs), opts, false);
  } catch (e) {
    if (e instanceof BundleError) {
      return {
        ok: false,
        exit_code: e.code === "bundle_trust_store_invalid" ? 2 : 1,
        path: abs,
        require_trusted: requireTrusted,
        error: { code: e.code, message: e.message },
      };
    }
    throw e;
  }
  const base = {
    path: abs,
    format: verified.bundle.format,
    status: verified.trust.status,
    ...(verified.trust.public_key ? { public_key: verified.trust.public_key } : {}),
    ...(verified.trust.key_label ? { key_label: verified.trust.key_label } : {}),
    require_trusted: requireTrusted,
  };
  try {
    enforceTrustPolicy(verified.trust, requireTrusted);
  } catch (e) {
    if (e instanceof BundleError && POLICY_CODES.has(e.code)) {
      return { ...base, ok: false, exit_code: 3, error: { code: e.code, message: e.message } };
    }
    throw e;
  }
  return { ...base, ok: true, exit_code: 0 };
}

/** One-line human summary of a verify report (identical text in the Python engine). */
export function formatBundleVerifyReport(r: BundleVerifyReport): string {
  if (r.exit_code === 1 || r.exit_code === 2) {
    return `INVALID ${r.error?.code ?? "bundle_invalid"}: ${r.error?.message ?? ""}`;
  }
  const signer = r.public_key ? ` ed25519 public_key=${r.public_key}` : "";
  const label = r.key_label ? ` key_label=${r.key_label}` : "";
  if (r.exit_code === 3) {
    return `REJECTED ${r.status}${signer} (${r.format}): ${r.error?.message ?? ""}`;
  }
  return `OK ${r.status}${signer}${label} (${r.format})`;
}

/**
 * Unpack a validated bundle into outDir. Refuses to write until validation succeeds.
 * Creates nested parent dirs for v0.2 connector paths. Does not write embedded resolved IR.
 */
export function unpackBundle(
  bundle: HarnessBundle | Record<string, unknown> | string,
  outDir: string,
  opts: { force?: boolean } & BundleLoadOptions = {},
): string {
  const b = typeof bundle === "string" ? loadBundleFile(bundle, opts) : validateBundle(bundle, opts);
  const dest = resolve(outDir);
  if (existsSync(dest)) {
    const ents = readdirSync(dest);
    if (ents.length && !opts.force) {
      throw new BundleError("bundle_invalid", `output directory not empty: ${dest} (pass --force)`);
    }
  } else {
    mkdirSync(dest, { recursive: true });
  }
  writeBundleFiles(b, dest);
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
  bundleFormat?: typeof BUNDLE_FORMAT_V01 | typeof BUNDLE_FORMAT_V02 | typeof BUNDLE_FORMAT_V03;
  /**
   * Verified embedded resolved IR from a v0.2 bundle.
   * Authoritative for bundle execution; not written into the unpacked source tree.
   */
  embeddedResolved?: ResolvedHarnessIR;
  /** Trust classification when kind=bundle. */
  trust?: BundleTrust;
};

/**
 * Resolve a harness directory or `.fausth.json` bundle to a usable harness directory.
 * Bundle contents are unpacked to a temporary directory that is registered with the
 * adapter provenance registry (so host adapters can refuse bundle-declared commands).
 */
export function resolveHarnessRef(ref: string, opts: BundleLoadOptions = {}): ResolvedHarness {
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
    const { bundle: loaded, trust } = loadVerifiedBundleFile(abs, opts);
    const tmp = mkdtempSync(join(tmpdir(), "fausth-bundle-"));
    try {
      writeBundleFiles(loaded, tmp);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    registerBundleDir(tmp, {
      bundle: abs,
      format: loaded.format,
      trust: trust.status,
      ...(trust.public_key ? { public_key: trust.public_key } : {}),
    });
    return {
      kind: "bundle",
      harnessDir: tmp,
      cleanup: () => {
        unregisterBundleDir(tmp);
        rmSync(tmp, { recursive: true, force: true });
      },
      source: abs,
      bundleFormat: loaded.format,
      embeddedResolved: isHarnessBundleV2(loaded) ? loaded.resolved : undefined,
      trust,
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
  opts: BundleLoadOptions = {},
): Promise<T> {
  const resolved = resolveHarnessRef(ref, opts);
  try {
    return await fn(resolved.harnessDir, resolved);
  } finally {
    resolved.cleanup();
  }
}

export function bundleCanonicalJson(bundle: HarnessBundle): string {
  return canonicalJson(bundle) + "\n";
}
