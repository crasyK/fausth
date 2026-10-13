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
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BundleError,
  BUNDLE_FORMAT_V01,
  BUNDLE_FORMAT_V02,
  BUNDLE_FORMAT_V03,
  formatBundleVerifyReport,
  isHarnessBundleV2,
  loadBundleFile,
  loadVerifiedBundleFile,
  resolveHarnessRef,
  unpackBundle,
  validateBundle,
  verifyBundleFile,
  withHarnessRef,
} from "./bundle.js";
import {
  BundleSignatureError,
  generateEd25519SeedHex,
  parseTrustStore,
  REQUIRE_TRUSTED_ENV,
  signBundle,
  TRUSTED_KEYS_ENV,
} from "./bundle-signature.js";
import { bundleProvenanceFor } from "./adapters/provenance.js";
import { resolveHarness, resolvedHarnessHash } from "./connectors/resolve.js";
import { packHarness, testHarness } from "./packaging.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const codingHarness = join(root, "examples/coding-counterbalance");
const connectorHarness = join(root, "examples/primitives/inline-file-connectors");
const moduleHarness = join(root, "examples/primitives/module-connectors");

/** Pack the connector harness signed with a fresh key; returns paths + public key. */
function packSigned(outDir: string, harness = connectorHarness): { out: string; publicKey: string; seedPath: string } {
  const seedPath = join(outDir, `seed-${Math.random().toString(16).slice(2)}.hex`);
  const { seed_hex, public_key } = generateEd25519SeedHex();
  writeFileSync(seedPath, seed_hex + "\n", "utf8");
  const { out } = packHarness(harness, join(outDir, `signed-${Math.random().toString(16).slice(2)}.fausth.json`), {
    signKey: seedPath,
  });
  return { out, publicKey: public_key, seedPath };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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
  it("unsigned coding pack stays 15463 bytes", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-unsigned-size-"));
    const { out, signed } = packHarness(
      codingHarness,
      join(outDir, "coding.fausth.json"),
    );
    assert.equal(signed, false);
    assert.equal(readFileSync(out).byteLength, 15463);
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

describe("bundle trust store (EDGE-1)", () => {
  it("parses keys files strictly: labels, comments, blank lines, BOM, CRLF; rejects garbage", () => {
    const a = "ab".repeat(32);
    const b = "CD".repeat(32);
    const store = parseTrustStore(`﻿# release keys\r\n${a} release-2026\r\n\r\n${b}\n`, "keys.txt");
    assert.equal(store.keys.size, 2);
    assert.equal(store.keys.get(a)?.label, "release-2026");
    assert.equal(store.keys.get("cd".repeat(32))?.label, undefined);
    assert.throws(
      () => parseTrustStore(`${a}\nnot-a-key\n`),
      (e: unknown) => e instanceof BundleSignatureError && e.code === "bundle_trust_store_invalid",
    );
    assert.throws(() => parseTrustStore("ab".repeat(31) + "\n"), BundleSignatureError);
  });

  it("verify reports unsigned / signed-untrusted / signed-trusted / tampered / policy-rejected", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-trust-"));
    try {
      const unsigned = packHarness(connectorHarness, join(outDir, "u.fausth.json")).out;
      const { out: signed, publicKey } = packSigned(outDir);
      const other = generateEd25519SeedHex().public_key;
      const trusted = join(outDir, "trusted.keys");
      writeFileSync(trusted, `# ops\n${publicKey} release-2026\n`, "utf8");
      const untrusted = join(outDir, "untrusted.keys");
      writeFileSync(untrusted, `${other} someone-else\n`, "utf8");

      const r1 = verifyBundleFile(unsigned, { trustedKeys: trusted });
      assert.equal(r1.status, "unsigned");
      assert.equal(r1.exit_code, 0);
      assert.equal(formatBundleVerifyReport(r1), `OK unsigned (${BUNDLE_FORMAT_V02})`);

      const r2 = verifyBundleFile(signed, { trustedKeys: untrusted });
      assert.equal(r2.status, "signed-untrusted");
      assert.equal(r2.public_key, publicKey);
      assert.equal(r2.exit_code, 0);

      const r3 = verifyBundleFile(signed, { trustedKeys: trusted, requireTrusted: true });
      assert.equal(r3.status, "signed-trusted");
      assert.equal(r3.key_label, "release-2026");
      assert.equal(r3.exit_code, 0);
      assert.equal(
        formatBundleVerifyReport(r3),
        `OK signed-trusted ed25519 public_key=${publicKey} key_label=release-2026 (${BUNDLE_FORMAT_V02})`,
      );

      const r4 = verifyBundleFile(unsigned, { trustedKeys: trusted, requireTrusted: true });
      assert.equal(r4.exit_code, 3);
      assert.equal(r4.error?.code, "bundle_unsigned");
      assert.match(formatBundleVerifyReport(r4), /^REJECTED unsigned/);

      const r5 = verifyBundleFile(signed, { trustedKeys: untrusted, requireTrusted: true });
      assert.equal(r5.exit_code, 3);
      assert.equal(r5.error?.code, "bundle_signature_untrusted");

      const raw = JSON.parse(readFileSync(signed, "utf8")) as { files: Record<string, string> };
      raw.files["agent.yml"] += "\n# tampered\n";
      const tampered = join(outDir, "tampered.fausth.json");
      writeFileSync(tampered, JSON.stringify(raw) + "\n", "utf8");
      const r6 = verifyBundleFile(tampered, { trustedKeys: trusted });
      assert.equal(r6.exit_code, 1);
      assert.equal(r6.error?.code, "bundle_signature_invalid");
      assert.match(formatBundleVerifyReport(r6), /^INVALID bundle_signature_invalid/);

      const r7 = verifyBundleFile(signed, { trustedKeys: join(outDir, "missing.keys") });
      assert.equal(r7.exit_code, 2);
      assert.equal(r7.error?.code, "bundle_trust_store_invalid");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("FAUSTH_TRUSTED_KEYS + FAUSTH_REQUIRE_TRUSTED_BUNDLES enforce the policy at load/unpack", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-trust-env-"));
    try {
      const unsigned = packHarness(connectorHarness, join(outDir, "u.fausth.json")).out;
      const { out: signed, publicKey } = packSigned(outDir);
      const trusted = join(outDir, "trusted.keys");
      writeFileSync(trusted, `${publicKey}\n`, "utf8");
      withEnv({ [TRUSTED_KEYS_ENV]: trusted, [REQUIRE_TRUSTED_ENV]: "1" }, () => {
        assert.throws(
          () => loadBundleFile(unsigned),
          (e: unknown) => e instanceof BundleError && e.code === "bundle_unsigned",
        );
        assert.throws(
          () => unpackBundle(unsigned, join(outDir, "nope")),
          (e: unknown) => e instanceof BundleError && e.code === "bundle_unsigned",
        );
        assert.equal(existsSync(join(outDir, "nope")), false);
        const { trust } = loadVerifiedBundleFile(signed);
        assert.equal(trust.status, "signed-trusted");
      });
      withEnv({ [TRUSTED_KEYS_ENV]: undefined, [REQUIRE_TRUSTED_ENV]: "1" }, () => {
        assert.throws(
          () => loadBundleFile(signed),
          (e: unknown) => e instanceof BundleError && e.code === "bundle_signature_untrusted",
        );
      });
      withEnv({ [TRUSTED_KEYS_ENV]: undefined, [REQUIRE_TRUSTED_ENV]: undefined }, () => {
        assert.equal(loadVerifiedBundleFile(signed).trust.status, "signed-untrusted");
        assert.equal(loadVerifiedBundleFile(unsigned).trust.status, "unsigned");
      });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("resolveHarnessRef registers the unpacked dir with its trust status (PY-3 provenance)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-trust-prov-"));
    try {
      const { out: signed, publicKey } = packSigned(outDir);
      const trusted = join(outDir, "trusted.keys");
      writeFileSync(trusted, `${publicKey} ci\n`, "utf8");
      const ref = resolveHarnessRef(signed, { trustedKeys: trusted });
      const dir = ref.harnessDir;
      try {
        assert.equal(ref.trust?.status, "signed-trusted");
        const prov = bundleProvenanceFor(join(dir, "deployment.fixture.yml"));
        assert.equal(prov?.trust, "signed-trusted");
        assert.equal(prov?.public_key, publicKey);
        assert.equal(prov?.format, BUNDLE_FORMAT_V02);
      } finally {
        ref.cleanup();
      }
      assert.equal(bundleProvenanceFor(dir), undefined);

      const unsignedRef = resolveHarnessRef(packHarness(connectorHarness, join(outDir, "u.fausth.json")).out, {
        trustedKeys: trusted,
      });
      try {
        assert.equal(bundleProvenanceFor(unsignedRef.harnessDir)?.trust, "unsigned");
      } finally {
        unsignedRef.cleanup();
      }
      assert.equal(bundleProvenanceFor(connectorHarness), undefined);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("rejects a null signature, unknown top-level fields, and non-integral numbers as bundle errors", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-shape-"));
    try {
      const { out } = packHarness(connectorHarness, join(outDir, "b.fausth.json"));
      const raw = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
      assert.throws(
        () => validateBundle({ ...raw, signature: null }),
        (e: unknown) => e instanceof BundleError && e.code === "bundle_signature_invalid",
      );
      assert.throws(
        () => validateBundle({ ...raw, smuggled: { run: "this" } }),
        (e: unknown) => e instanceof BundleError && e.code === "bundle_invalid",
      );
      const withFloat = structuredClone(raw) as { resolved: { agent: { state: Record<string, unknown> } } };
      withFloat.resolved.agent.state.threshold = 0.5;
      assert.throws(
        () => validateBundle(withFloat),
        (e: unknown) => e instanceof BundleError && e.code === "bundle_invalid",
      );
      const longName = `connectors/${"a".repeat(200)}.yml`;
      assert.throws(
        () =>
          validateBundle({
            ...(raw as object),
            files: { ...(raw.files as Record<string, string>), [longName]: "x" },
          }),
        (e: unknown) => e instanceof BundleError && e.code === "bundle_path",
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("bundle embedded resolved must match shipped sources (EDGE-12)", () => {
  it("rejects a bundle whose executable resolved IR differs from its agent.yml", () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-reresolve-"));
    try {
      const { out } = packHarness(connectorHarness, join(outDir, "b.fausth.json"));
      const raw = JSON.parse(readFileSync(out, "utf8")) as {
        resolved: import("./types.js").ResolvedHarnessIR;
        resolved_sha256: string;
        files: Record<string, string>;
      };
      // Shipped agent.yml stays harmless; the executable IR silently widens permissions.
      raw.resolved.agent.permissions = {
        ...(raw.resolved.agent.permissions ?? {}),
        tools: [...(raw.resolved.agent.permissions?.tools ?? []), "evil.exfiltrate"],
      };
      raw.resolved_sha256 = resolvedHarnessHash(raw.resolved);
      const dest = join(outDir, "out");
      assert.throws(
        () => unpackBundle(raw, dest),
        (e: unknown) => e instanceof BundleError && e.code === "bundle_resolved_mismatch",
      );
      assert.equal(existsSync(dest), false);

      // Signing the forged bundle does not help: integrity is checked against the sources.
      const seed = join(outDir, "seed.hex");
      writeFileSync(seed, generateEd25519SeedHex().seed_hex, "utf8");
      const forged = join(outDir, "forged.fausth.json");
      writeFileSync(forged, JSON.stringify(signBundle(raw, seed)) + "\n", "utf8");
      const r = verifyBundleFile(forged);
      assert.equal(r.exit_code, 1);
      assert.equal(r.error?.code, "bundle_resolved_mismatch");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("bundle v0.3 module connectors (EDGE-11)", () => {
  it("pack → load → unpack → test round-trips a module-connector harness", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-mod-"));
    try {
      const { out, format, files } = packHarness(moduleHarness, join(outDir, "m.fausth.json"));
      assert.equal(format, BUNDLE_FORMAT_V03);
      assert.ok(files.includes("connectors/module/echo.json"));
      assert.ok(files.includes("module.recorded.jsonl"));
      const bundle = loadBundleFile(out);
      assert.ok(isHarnessBundleV2(bundle));
      assert.ok(bundle.resolved.resolution.lock.some((l) => l.kind === "module"));
      const unpackDir = join(outDir, "unpacked");
      unpackBundle(out, unpackDir);
      assert.ok(existsSync(join(unpackDir, "connectors/module/echo.json")));
      const result = await withHarnessRef(out, async (dir, ref) =>
        testHarness(dir, {
          skipFixtures: true,
          embeddedResolved: ref.embeddedResolved,
          bundleFormat: ref.bundleFormat,
        }),
      );
      assert.equal(result.ok, true, result.errors.join("\n"));
      assert.equal(result.smoke_ok, true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("never packs entries the loader rejects for the chosen format", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-pack-consistency-"));
    try {
      for (const name of ["agent.yml", "connectors.yml", "deployment.fixture.yml", "smoke.model.jsonl", "smoke.expected.jsonl"]) {
        const src = join(connectorHarness, name);
        if (existsSync(src)) writeFileSync(join(dir, name), readFileSync(src));
      }
      mkdirSync(join(dir, "connectors"));
      writeFileSync(join(dir, "connectors/wait.yml"), readFileSync(join(connectorHarness, "connectors/wait.yml")));
      // A stray recorded MCP fixture next to a v0.2 (file/inline only) harness.
      writeFileSync(join(dir, "mcp.recorded.jsonl"), '{"tool":"x","result":{}}\n', "utf8");
      const { out, format, files } = packHarness(dir, join(dir, "dist/p.fausth.json"));
      assert.equal(format, BUNDLE_FORMAT_V02);
      assert.equal(files.includes("mcp.recorded.jsonl"), false);
      assert.equal(loadBundleFile(out).format, BUNDLE_FORMAT_V02);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves CRLF bytes in packed files and lock pins (PY-13 parity)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-crlf-"));
    try {
      writeFileSync(
        join(dir, "agent.yml"),
        "spec: counterbalance-contract/v0.1\r\nname: crlf\r\nstate: {}\r\ntools:\r\n  - id: ping.local\r\n",
        "utf8",
      );
      mkdirSync(join(dir, "connectors"));
      const manifest = "format: fausth-connector-manifest/v0.1\r\nprovides:\r\n  - id: echo.ping\r\n    description: \"crlf\"\r\n";
      writeFileSync(join(dir, "connectors/echo.yml"), manifest, "utf8");
      writeFileSync(
        join(dir, "connectors.yml"),
        "format: fausth-connectors/v0.1\r\nconnectors:\r\n  - id: echo\r\n    kind: file\r\n    path: connectors/echo.yml\r\n",
        "utf8",
      );
      const resolved = resolveHarness(dir);
      const lock = resolved.resolution.lock.find((l) => l.kind === "file")!;
      assert.equal(lock.sha256, createHash("sha256").update(Buffer.from(manifest, "utf8")).digest("hex"));
      const { out } = packHarness(dir, join(dir, "dist/c.fausth.json"));
      const bundle = loadBundleFile(out);
      assert.equal(bundle.files["connectors/echo.yml"], manifest);
      assert.ok(bundle.files["agent.yml"]!.includes("\r\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
