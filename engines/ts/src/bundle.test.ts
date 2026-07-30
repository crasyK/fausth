import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BundleError,
  BUNDLE_FORMAT_V01,
  BUNDLE_FORMAT_V02,
  isHarnessBundleV2,
  loadBundleFile,
  resolveHarnessRef,
  unpackBundle,
  validateBundle,
  withHarnessRef,
} from "./bundle.js";
import { generateEd25519SeedHex } from "./bundle-signature.js";
import { resolveHarness, resolvedHarnessHash } from "./connectors/resolve.js";
import { packHarness, testHarness } from "./packaging.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const codingHarness = join(root, "examples/coding-counterbalance");
const connectorHarness = join(root, "examples/primitives/inline-file-connectors");

describe("bundle v0.1", () => {
  it("rejects traversal and unknown entries before write", () => {
    assert.throws(
      () =>
        validateBundle({
          format: BUNDLE_FORMAT_V01,
          name: "evil",
          files: { "../etc/passwd": "x", "agent.yml": "name: x\n" },
        }),
      BundleError,
    );
    assert.throws(
      () =>
        validateBundle({
          format: BUNDLE_FORMAT_V01,
          name: "evil",
          files: { "secret.bin": "x", "agent.yml": "name: x\n" },
        }),
      BundleError,
    );
    assert.throws(
      () =>
        validateBundle({
          format: BUNDLE_FORMAT_V01,
          name: "evil",
          files: { "connectors.yml": "x", "agent.yml": "name: x\n" },
        }),
      (e: unknown) => e instanceof BundleError && e.code === "bundle_unknown_entry",
    );
  });

  it("pack → validate → unpack → test", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-pack-"));
    const { out, format } = packHarness(
      codingHarness,
      join(outDir, "coding-counterbalance.fausth.json"),
    );
    assert.equal(format, BUNDLE_FORMAT_V01);
    const bundle = loadBundleFile(out);
    assert.equal(bundle.format, BUNDLE_FORMAT_V01);
    assert.ok(bundle.files["agent.yml"]);
    assert.equal("resolved" in bundle, false);

    const unpackDir = join(outDir, "unpacked");
    unpackBundle(out, unpackDir);
    assert.ok(existsSync(join(unpackDir, "agent.yml")));

    const result = await withHarnessRef(out, async (dir, ref) => {
      assert.equal(ref.bundleFormat, BUNDLE_FORMAT_V01);
      assert.equal(ref.embeddedResolved, undefined);
      return testHarness(dir, { skipFixtures: false });
    });
    assert.equal(result.ok, true);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("malicious paths fail before filesystem mutation", () => {
    const dest = mkdtempSync(join(tmpdir(), "fausth-evil-"));
    assert.throws(
      () =>
        unpackBundle(
          {
            format: BUNDLE_FORMAT_V01,
            name: "evil",
            files: {
              "agent.yml": "spec: x\nname: x\nstate: {}\ntools: []\n",
              "../../escape.yml": "nope",
            },
          },
          join(dest, "out"),
        ),
      BundleError,
    );
    assert.equal(existsSync(join(dest, "out")), false);
    rmSync(dest, { recursive: true, force: true });
  });
});

describe("bundle v0.2", () => {
  it("pack connector harness with nested files and verified resolved IR", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-v02-"));
    const { out, format } = packHarness(
      connectorHarness,
      join(outDir, "inline-file-connectors.fausth.json"),
    );
    assert.equal(format, BUNDLE_FORMAT_V02);
    const bundle = loadBundleFile(out);
    assert.ok(isHarnessBundleV2(bundle));
    assert.ok(bundle.files["connectors.yml"]);
    assert.ok(bundle.files["connectors/wait.yml"]);
    assert.equal(bundle.resolved_sha256, resolvedHarnessHash(bundle.resolved));
    assert.equal(bundle.resolved.format, "fausth-resolved-harness/v0.1");

    const unpackDir = join(outDir, "unpacked");
    unpackBundle(out, unpackDir);
    assert.ok(existsSync(join(unpackDir, "connectors", "wait.yml")));
    assert.equal(existsSync(join(unpackDir, "resolved.json")), false);

    const result = await withHarnessRef(out, async (dir, ref) => {
      assert.equal(ref.bundleFormat, BUNDLE_FORMAT_V02);
      assert.ok(ref.embeddedResolved);
      assert.equal(
        resolvedHarnessHash(ref.embeddedResolved!),
        bundle.resolved_sha256,
      );
      return testHarness(dir, {
        skipFixtures: true,
        embeddedResolved: ref.embeddedResolved,
        bundleFormat: ref.bundleFormat,
      });
    });
    assert.equal(result.ok, true);
    assert.ok(result.details.some((d) => d.includes("embedded resolved OK")));

    rmSync(outDir, { recursive: true, force: true });
  });

  it("rejects tampered resolved hash before write", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-tamper-"));
    const { out } = packHarness(connectorHarness, join(outDir, "b.fausth.json"));
    const raw = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    raw.resolved_sha256 = "0".repeat(64);
    const dest = join(outDir, "out");
    assert.throws(() => unpackBundle(raw, dest), (e: unknown) => {
      return e instanceof BundleError && e.code === "bundle_resolved_hash_mismatch";
    });
    assert.equal(existsSync(dest), false);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("rejects tampered connector source before write", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-tamper-src-"));
    const { out } = packHarness(connectorHarness, join(outDir, "b.fausth.json"));
    const raw = JSON.parse(readFileSync(out, "utf8")) as {
      files: Record<string, string>;
      [k: string]: unknown;
    };
    raw.files["connectors/wait.yml"] = raw.files["connectors/wait.yml"] + "\n# tampered\n";
    const dest = join(outDir, "out");
    assert.throws(() => unpackBundle(raw, dest), (e: unknown) => {
      return e instanceof BundleError && e.code === "bundle_lock_hash_mismatch";
    });
    assert.equal(existsSync(dest), false);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("rejects traversal, backslash, .git, and unknown nested entries", () => {
    const baseResolved = resolveHarness(connectorHarness);
    const hash = resolvedHarnessHash(baseResolved);
    const agent = readFileSync(join(connectorHarness, "agent.yml"), "utf8");

    assert.throws(
      () =>
        validateBundle({
          format: BUNDLE_FORMAT_V02,
          name: "evil",
          files: {
            "agent.yml": agent,
            "connectors/../secret.yml": "x",
          },
          resolved: baseResolved,
          resolved_sha256: hash,
        }),
      BundleError,
    );
    assert.throws(
      () =>
        validateBundle({
          format: BUNDLE_FORMAT_V02,
          name: "evil",
          files: {
            "agent.yml": agent,
            "connectors\\wait.yml": "x",
          },
          resolved: baseResolved,
          resolved_sha256: hash,
        }),
      BundleError,
    );
    assert.throws(
      () =>
        validateBundle({
          format: BUNDLE_FORMAT_V02,
          name: "evil",
          files: {
            "agent.yml": agent,
            "connectors/.git/config": "x",
          },
          resolved: baseResolved,
          resolved_sha256: hash,
        }),
      BundleError,
    );
    assert.throws(
      () =>
        validateBundle({
          format: BUNDLE_FORMAT_V02,
          name: "evil",
          files: {
            "agent.yml": agent,
            "connectors/wait.bin": "x",
          },
          resolved: baseResolved,
          resolved_sha256: hash,
        }),
      (e: unknown) => e instanceof BundleError && e.code === "bundle_unknown_entry",
    );
  });

  it("embedded resolved stays authoritative vs re-resolve after source mutation", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-auth-"));
    const { out } = packHarness(connectorHarness, join(outDir, "b.fausth.json"));
    const ref = resolveHarnessRef(out);
    try {
      const embeddedHash = resolvedHarnessHash(ref.embeddedResolved!);
      writeFileSync(
        join(ref.harnessDir, "connectors", "wait.yml"),
        readFileSync(join(ref.harnessDir, "connectors", "wait.yml"), "utf8").replace(
          "deterministic wait",
          "MUTATED wait",
        ),
        "utf8",
      );
      assert.equal(resolvedHarnessHash(ref.embeddedResolved!), embeddedHash);
      const reresolved = resolveHarness(ref.harnessDir);
      assert.notEqual(resolvedHarnessHash(reresolved), embeddedHash);
    } finally {
      ref.cleanup();
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("explicit unpack then re-resolve uses restored source", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-reunpack-"));
    const { out } = packHarness(connectorHarness, join(outDir, "b.fausth.json"));
    const unpackDir = join(outDir, "restored");
    unpackBundle(out, unpackDir);
    const fromDir = resolveHarness(unpackDir);
    const fromBundle = loadBundleFile(out);
    assert.ok(isHarnessBundleV2(fromBundle));
    assert.equal(resolvedHarnessHash(fromDir), fromBundle.resolved_sha256);
    assert.ok(readdirSync(join(unpackDir, "connectors")).includes("wait.yml"));
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("bundle signatures", () => {
  it("unsigned coding pack stays 15411 bytes", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-unsigned-size-"));
    const { out, signed } = packHarness(
      codingHarness,
      join(outDir, "coding.fausth.json"),
    );
    assert.equal(signed, false);
    assert.equal(readFileSync(out).byteLength, 15411);
    assert.equal("signature" in JSON.parse(readFileSync(out, "utf8")), false);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("sign → verify ok; tamper files/sig rejects before write", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-sig-"));
    const seedPath = join(outDir, "seed.hex");
    const { seed_hex } = generateEd25519SeedHex();
    writeFileSync(seedPath, seed_hex + "\n", "utf8");

    const { out, signed } = packHarness(
      connectorHarness,
      join(outDir, "signed.fausth.json"),
      { signKey: seedPath },
    );
    assert.equal(signed, true);
    const bundle = loadBundleFile(out);
    assert.ok(bundle.signature);
    assert.equal(bundle.signature!.alg, "ed25519");

    const unpackDir = join(outDir, "ok");
    unpackBundle(out, unpackDir);
    assert.ok(existsSync(join(unpackDir, "agent.yml")));

    const raw = JSON.parse(readFileSync(out, "utf8")) as {
      files: Record<string, string>;
      signature: { alg: string; public_key: string; sig: string };
      [k: string]: unknown;
    };

    const destFiles = join(outDir, "tamper-files");
    raw.files["agent.yml"] = raw.files["agent.yml"] + "\n# tampered\n";
    assert.throws(() => unpackBundle(raw, destFiles), (e: unknown) => {
      return e instanceof BundleError && e.code === "bundle_signature_invalid";
    });
    assert.equal(existsSync(destFiles), false);

    const destSig = join(outDir, "tamper-sig");
    const raw2 = JSON.parse(readFileSync(out, "utf8")) as {
      signature: { alg: string; public_key: string; sig: string };
      [k: string]: unknown;
    };
    raw2.signature.sig = "ab".repeat(64);
    assert.throws(() => unpackBundle(raw2, destSig), (e: unknown) => {
      return e instanceof BundleError && e.code === "bundle_signature_invalid";
    });
    assert.equal(existsSync(destSig), false);

    const destAlg = join(outDir, "tamper-alg");
    const raw3 = JSON.parse(readFileSync(out, "utf8")) as {
      signature: { alg: string; public_key: string; sig: string };
      [k: string]: unknown;
    };
    raw3.signature.alg = "rsa-pss";
    assert.throws(() => unpackBundle(raw3, destAlg), (e: unknown) => {
      return e instanceof BundleError && e.code === "bundle_signature_unsupported";
    });
    assert.equal(existsSync(destAlg), false);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("signed v0.1 coding pack verifies", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-sig-v01-"));
    const seedPath = join(outDir, "seed.hex");
    writeFileSync(seedPath, generateEd25519SeedHex().seed_hex + "\n", "utf8");
    const { out } = packHarness(codingHarness, join(outDir, "c.fausth.json"), {
      signKey: seedPath,
    });
    const bundle = loadBundleFile(out);
    assert.equal(bundle.format, BUNDLE_FORMAT_V01);
    assert.ok(bundle.signature);
    unpackBundle(out, join(outDir, "out"));
    rmSync(outDir, { recursive: true, force: true });
  });
});
