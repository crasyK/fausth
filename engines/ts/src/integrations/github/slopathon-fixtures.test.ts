/**
 * Offline golden checks for examples/slopathon-review/testdata.
 * Packet in → deterministic conclusion (+ evidence-verify samples for soft fixtures).
 * Does not call live models.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { packetFromFixtureDir } from "./packet-build.js";
import {
  filterVerifiedFindings,
  verifyFindingEvidence,
  type ReviewFinding,
} from "./submission-check.js";

const here = dirname(fileURLToPath(import.meta.url));
const testdataRoot = resolve(here, "../../../../../examples/slopathon-review/testdata");

type Expectation = {
  label?: string;
  expected_deterministic: "pass" | "fail";
  expect_categories_any?: string[];
  min_ai_findings?: number;
  max_ai_findings?: number;
  /** Soft-fault fixtures: sample findings that MUST verify against the packet. */
  golden_verified_findings?: ReviewFinding[];
  /** Soft-fault fixtures: sample findings that MUST be dropped by evidence gate. */
  golden_rejected_findings?: ReviewFinding[];
};

function listFixtureDirs(root: string): string[] {
  return readdirSync(root)
    .map((n) => join(root, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "expected.json")))
    .sort();
}

describe("slopathon-review testdata goldens (offline)", () => {
  const dirs = listFixtureDirs(testdataRoot);
  assert.ok(dirs.length >= 5, `expected testdata fixtures under ${testdataRoot}`);

  for (const dir of dirs) {
    const name = dir.split(/[/\\]/).pop()!;
    it(`${name}: deterministic matches expected.json`, () => {
      const exp = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expectation & {
        expected_conclusion?: "pass" | "fail";
      };
      const want = exp.expected_deterministic ?? exp.expected_conclusion;
      assert.ok(want, `${name}: expected.json missing expected_deterministic`);
      const packet = packetFromFixtureDir(dir);
      assert.equal(
        packet.conclusion,
        want,
        `${name}: deterministic=${packet.conclusion} expected ${want}; findings=${JSON.stringify(packet.deterministic_findings)}`,
      );
    });
  }

  it("subtle-contradiction: golden findings verify / reject correctly", () => {
    const dir = join(testdataRoot, "subtle-contradiction");
    const exp = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expectation;
    const packet = packetFromFixtureDir(dir);
    assert.equal(packet.conclusion, "pass");

    const good: ReviewFinding = {
      category: "contradiction",
      severity: "blocking",
      path: "projects/contradiction/README.md",
      evidence: "No API keys required",
      recommendation: "Resolve the contradiction between Setup and Demo regarding API keys.",
    };
    const badPath: ReviewFinding = {
      category: "contradiction",
      severity: "blocking",
      path: "projects/other/README.md",
      evidence: "No API keys required",
      recommendation: "bad path should drop",
    };
    const badSnippet: ReviewFinding = {
      category: "contradiction",
      severity: "blocking",
      path: "projects/contradiction/README.md",
      evidence: "this-snippet-is-not-in-the-file-zzzz",
      recommendation: "bad snippet should drop",
    };

    assert.equal(verifyFindingEvidence(good, packet).ok, true);
    assert.equal(verifyFindingEvidence(badPath, packet).ok, false);
    assert.equal(verifyFindingEvidence(badSnippet, packet).ok, false);

    const { kept, dropped } = filterVerifiedFindings([good, badPath, badSnippet], packet);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 2);
    assert.ok((exp.expect_categories_any ?? []).includes(kept[0]!.category));
  });

  it("subtle-klarna-ci: L1 pass + contradiction evidence verifies", () => {
    const dir = join(testdataRoot, "subtle-klarna-ci");
    const packet = packetFromFixtureDir(dir);
    assert.equal(packet.conclusion, "pass");
    const finding: ReviewFinding = {
      category: "contradiction",
      severity: "blocking",
      path: "projects/klarna-bnpl/README.md",
      evidence: "No API keys required",
      recommendation: "Remove the no-API-keys claim or the CLOUD_VENDOR_AUTH_TOKEN requirement.",
    };
    assert.equal(verifyFindingEvidence(finding, packet).ok, true);
    const safety: ReviewFinding = {
      category: "safety_concern",
      severity: "blocking",
      path: "projects/klarna-bnpl/README.md",
      evidence: "hardcode the admin password as `admin`",
      recommendation: "Do not hardcode admin passwords or disable authentication.",
    };
    // evidence must be exact substring — check file for a stable snippet
    const readme = packet.files.find((f) => f.path.endsWith("README.md"))?.content ?? "";
    const snippet = "hardcode the admin password";
    assert.ok(readme.includes(snippet), "klarna README should contain admin-password soft fault");
    safety.evidence = snippet;
    assert.equal(verifyFindingEvidence(safety, packet).ok, true);
  });
});
