/**
 * SCR-19: script tests and recorded smokes run in CI, failures fail, and no
 * script is silently dead.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const YAML = createRequire(join(root, "engines/ts/package.json"))("yaml");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ciText = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const ci = YAML.parse(ciText);
const nightlyText = readFileSync(join(root, ".github/workflows/live-openrouter.yml"), "utf8");
const nightly = YAML.parse(nightlyText);

/** @param {any} wf */
function allRuns(wf) {
  return Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => String(s.run ?? "")));
}

describe("CI wiring", () => {
  it("runs every scripts/*.test.mjs via test:scripts", () => {
    assert.equal(pkg.scripts["test:scripts"], "node --test scripts/*.test.mjs");
    assert.ok(allRuns(ci).some((r) => r.includes("pnpm test:scripts")));
  });

  it("runs the recorded smokes, release check and evidence check", () => {
    const runs = allRuns(ci).join("\n");
    for (const s of ["ci:adversarial", "ci:tau-recorded", "ci:swe-recorded", "ci:release-check", "evidence:check"]) {
      assert.ok(runs.includes(`pnpm ${s}`), s);
      assert.ok(pkg.scripts[s], s);
    }
  });

  it("keeps replay and smoke independent so one failure cannot mask the other", () => {
    const jobOf = (needle) =>
      Object.entries(ci.jobs).find(([, j]) => j.steps.some((s) => String(s.run ?? "").includes(needle)))?.[0];
    assert.notEqual(jobOf("src/cli.ts replay"), jobOf("scripts/local-e2e.mjs"));
    for (const job of Object.values(ci.jobs)) {
      const checks = job.steps.filter((s) => s.name && s.run && !/install/.test(s.run));
      if (checks.length > 1) {
        for (const s of checks) assert.equal(s.if, "${{ !cancelled() }}", `${s.name} must run independently`);
      }
    }
  });

  it("nightly live local e2e steps propagate failures", () => {
    const steps = Object.values(nightly.jobs).flatMap((j) => j.steps);
    const e2e = steps.filter((s) => /live-local-e2e\.mjs/.test(String(s.run ?? "")));
    assert.equal(e2e.length, 2);
    for (const s of e2e) {
      const lines = String(s.run).trim().split("\n");
      assert.equal(lines[lines.length - 1].trim(), "exit $code", s.name);
    }
  });

  it("the live e2e seed test is meaningful (no trivial assertion, held-out check)", () => {
    const src = readFileSync(join(here, "live-local-e2e.mjs"), "utf8");
    assert.doesNotMatch(src, /assert\.equal\(1, ?1\)/);
    assert.match(src, /heldOutCheck/);
  });

  it("every host script is referenced or explicitly marked", () => {
    const referenced = [
      JSON.stringify(pkg.scripts),
      ciText,
      nightlyText,
      readFileSync(join(root, ".github/workflows/multi-host.yml"), "utf8"),
      ...readdirSync(here)
        .filter((f) => f.endsWith(".mjs") || f.endsWith(".sh"))
        .map((f) => readFileSync(join(here, f), "utf8")),
    ].join("\n");
    for (const f of readdirSync(here)) {
      if (!/\.(mjs|sh)$/.test(f) || f.endsWith(".test.mjs")) continue;
      const self = readFileSync(join(here, f), "utf8");
      const others = referenced.replace(self, "");
      const marked = /ONE-SHOT GENERATOR/.test(self);
      assert.ok(others.includes(f) || marked, `${f} is neither referenced nor marked`);
    }
  });
});
