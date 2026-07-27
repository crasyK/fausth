import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BundleError,
  loadBundleFile,
  unpackBundle,
  validateBundle,
  withHarnessRef,
} from "./bundle.js";
import { packHarness, testHarness } from "./packaging.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const harness = join(root, "examples/coding-counterbalance");

describe("bundle", () => {
  it("rejects traversal and unknown entries before write", () => {
    assert.throws(
      () =>
        validateBundle({
          format: "fausth-harness-bundle/v0.1",
          name: "evil",
          files: { "../etc/passwd": "x", "agent.yml": "name: x\n" },
        }),
      BundleError,
    );
    assert.throws(
      () =>
        validateBundle({
          format: "fausth-harness-bundle/v0.1",
          name: "evil",
          files: { "secret.bin": "x", "agent.yml": "name: x\n" },
        }),
      BundleError,
    );
  });

  it("pack → validate → unpack → test", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "fausth-pack-"));
    const { out } = packHarness(harness, join(outDir, "coding-counterbalance.fausth.json"));
    const bundle = loadBundleFile(out);
    assert.equal(bundle.format, "fausth-harness-bundle/v0.1");
    assert.ok(bundle.files["agent.yml"]);

    const unpackDir = join(outDir, "unpacked");
    unpackBundle(out, unpackDir);
    assert.ok(existsSync(join(unpackDir, "agent.yml")));

    const result = await withHarnessRef(out, async (dir) => testHarness(dir, { skipFixtures: false }));
    assert.equal(result.ok, true);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("malicious paths fail before filesystem mutation", () => {
    const dest = mkdtempSync(join(tmpdir(), "fausth-evil-"));
    const marker = join(dest, "should-stay-empty");
    mkdirSync(marker);
    assert.throws(
      () =>
        unpackBundle(
          {
            format: "fausth-harness-bundle/v0.1",
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
