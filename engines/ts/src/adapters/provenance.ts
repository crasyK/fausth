/**
 * Harness-directory provenance for the trust boundary.
 *
 * When a `.fausth.json` bundle is unpacked to a temp directory, the bundle loader
 * registers that directory here together with the bundle's trust status. Host
 * adapters consult it before doing anything a bundle author must not be able to
 * trigger on their own (e.g. spawning a stdio command declared by a deployment file
 * that shipped inside the bundle).
 *
 * Deliberately tiny and dependency-free so both bundle.ts and adapters can import it.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Three distinct outcomes of bundle signature verification against a trust store. */
export type BundleTrustStatus = "unsigned" | "signed-untrusted" | "signed-trusted";

export type BundleProvenance = {
  /** Absolute path of the source `.fausth.json` file. */
  bundle: string;
  /** Bundle format string (fausth-harness-bundle/v0.x). */
  format: string;
  trust: BundleTrustStatus;
  /** Signer public key (hex) when signed. */
  public_key?: string;
};

const registered = new Map<string, BundleProvenance>();

function canonicalDir(p: string): string {
  const abs = resolve(p);
  try {
    return existsSync(abs) ? realpathSync.native(abs) : abs;
  } catch {
    return abs;
  }
}

/** Record that `dir` holds files unpacked from a bundle. */
export function registerBundleDir(dir: string, info: BundleProvenance): void {
  registered.set(canonicalDir(dir), { ...info });
}

export function unregisterBundleDir(dir: string): void {
  registered.delete(canonicalDir(dir));
  registered.delete(resolve(dir));
}

/**
 * Provenance of `path` when it lies inside (or is) a registered bundle directory.
 * Resolves symlinks so aliases of the temp dir are still recognised.
 */
export function bundleProvenanceFor(path: string): BundleProvenance | undefined {
  if (!path) return undefined;
  const candidates = new Set([resolve(path), canonicalDir(path)]);
  for (const c of candidates) {
    for (const [dir, info] of registered) {
      if (c === dir || c.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return { ...info };
    }
  }
  return undefined;
}
