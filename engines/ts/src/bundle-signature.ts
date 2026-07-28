/**
 * Optional Ed25519 detached signatures for harness bundles (M10.4).
 *
 * Covered bytes: UTF-8 of canonicalJson(bundle without `signature`).
 * Signature object: { alg: "ed25519", public_key: hex32, sig: hex64 }.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./canonical.js";

export const BUNDLE_SIG_ALG = "ed25519" as const;

/** PKCS8 DER prefix for a 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** SPKI DER prefix for a 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type BundleSignature = {
  alg: typeof BUNDLE_SIG_ALG;
  public_key: string;
  sig: string;
};

export class BundleSignatureError extends Error {
  readonly code:
    | "bundle_signature_invalid"
    | "bundle_signature_unsupported"
    | "bundle_sign_key_invalid";
  constructor(code: BundleSignatureError["code"], message: string) {
    super(message);
    this.name = "BundleSignatureError";
    this.code = code;
  }
}

const HEX32_RE = /^[a-f0-9]{64}$/;
const HEX64_RE = /^[a-f0-9]{128}$/;

function privateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) {
    throw new BundleSignatureError(
      "bundle_sign_key_invalid",
      `Ed25519 seed must be 32 bytes, got ${seed.length}`,
    );
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) {
    throw new BundleSignatureError(
      "bundle_signature_invalid",
      `Ed25519 public key must be 32 bytes, got ${raw.length}`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function rawPublicKey(privateKey: KeyObject): Buffer {
  const pub = createPublicKey(privateKey);
  return pub.export({ type: "spki", format: "der" }).subarray(12);
}

/** Strip signature and return the object that is signed. */
export function signingPayload(bundle: Record<string, unknown>): Record<string, unknown> {
  const { signature: _sig, ...rest } = bundle;
  return rest;
}

/** UTF-8 bytes of canonical JSON of the unsigned payload. */
export function signingBytes(bundle: Record<string, unknown>): Buffer {
  return Buffer.from(canonicalJson(signingPayload(bundle)), "utf8");
}

export function parseBundleSignature(raw: unknown): BundleSignature {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BundleSignatureError("bundle_signature_invalid", "bundle.signature must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.alg !== BUNDLE_SIG_ALG) {
    throw new BundleSignatureError(
      "bundle_signature_unsupported",
      `unsupported signature alg: ${String(obj.alg)}`,
    );
  }
  if (typeof obj.public_key !== "string" || !HEX32_RE.test(obj.public_key)) {
    throw new BundleSignatureError(
      "bundle_signature_invalid",
      "bundle.signature.public_key must be 64-char lowercase hex (32-byte Ed25519 key)",
    );
  }
  if (typeof obj.sig !== "string" || !HEX64_RE.test(obj.sig)) {
    throw new BundleSignatureError(
      "bundle_signature_invalid",
      "bundle.signature.sig must be 128-char lowercase hex (64-byte Ed25519 signature)",
    );
  }
  const allowed = new Set(["alg", "public_key", "sig"]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new BundleSignatureError(
        "bundle_signature_invalid",
        `unexpected signature field: ${k}`,
      );
    }
  }
  return {
    alg: BUNDLE_SIG_ALG,
    public_key: obj.public_key,
    sig: obj.sig,
  };
}

/** Verify detached signature when present. No-op when signature is absent. */
export function verifyBundleSignature(bundle: Record<string, unknown>): void {
  if (!("signature" in bundle) || bundle.signature === undefined) return;
  const signature = parseBundleSignature(bundle.signature);
  const ok = cryptoVerify(
    null,
    signingBytes(bundle),
    publicKeyFromRaw(Buffer.from(signature.public_key, "hex")),
    Buffer.from(signature.sig, "hex"),
  );
  if (!ok) {
    throw new BundleSignatureError(
      "bundle_signature_invalid",
      "bundle signature verification failed",
    );
  }
}

export function loadSignKeyMaterial(input: string | Buffer): KeyObject {
  let raw: Buffer;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.includes("BEGIN") && trimmed.includes("PRIVATE KEY")) {
      return createPrivateKey(trimmed);
    }
    if (HEX32_RE.test(trimmed.toLowerCase().replace(/\s+/g, ""))) {
      raw = Buffer.from(trimmed.toLowerCase().replace(/\s+/g, ""), "hex");
      return privateKeyFromSeed(raw);
    }
    // Treat as filesystem path
    const abs = resolve(trimmed);
    const file = readFileSync(abs);
    return loadSignKeyMaterial(file);
  }
  const text = input.toString("utf8").trim();
  if (text.includes("BEGIN") && text.includes("PRIVATE KEY")) {
    return createPrivateKey(text);
  }
  const hex = text.toLowerCase().replace(/\s+/g, "");
  if (HEX32_RE.test(hex)) {
    return privateKeyFromSeed(Buffer.from(hex, "hex"));
  }
  if (input.length === 32) {
    return privateKeyFromSeed(input);
  }
  // Try DER PKCS8
  try {
    return createPrivateKey({ key: input, format: "der", type: "pkcs8" });
  } catch {
    throw new BundleSignatureError(
      "bundle_sign_key_invalid",
      "sign key must be 32-byte seed (raw or 64-hex), or PKCS8 PEM/DER Ed25519 private key",
    );
  }
}

export function loadSignKeyFromPath(path: string): KeyObject {
  return loadSignKeyMaterial(path);
}

/** Attach Ed25519 signature to a bundle object (mutates a shallow copy). */
export function signBundle(
  bundle: Record<string, unknown>,
  privateKey: KeyObject | string | Buffer,
): Record<string, unknown> {
  const key =
    typeof privateKey === "string" || Buffer.isBuffer(privateKey)
      ? loadSignKeyMaterial(privateKey)
      : privateKey;
  const unsigned = signingPayload(bundle);
  const sig = cryptoSign(null, Buffer.from(canonicalJson(unsigned), "utf8"), key);
  const public_key = rawPublicKey(key).toString("hex");
  return {
    ...unsigned,
    signature: {
      alg: BUNDLE_SIG_ALG,
      public_key,
      sig: sig.toString("hex"),
    } satisfies BundleSignature,
  };
}

/** Generate a new Ed25519 seed (hex) + matching public key hex for tests/docs. */
export function generateEd25519SeedHex(): { seed_hex: string; public_key: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  const seed = der.subarray(der.length - 32);
  return {
    seed_hex: seed.toString("hex"),
    public_key: rawPublicKey(privateKey).toString("hex"),
  };
}
