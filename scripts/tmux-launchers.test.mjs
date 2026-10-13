/**
 * SCR-17 / SCR-18 / SCR-8 (track-s): detached launchers quote every value, report
 * the runner's own exit status, and only aggregate their own run directories.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveRawDirs, shardCommand } from "./kit-tmux-shard.mjs";
import { buildCommand, validateRunPrefix } from "./opt-arms-tmux.mjs";
import { sequentialScript } from "./opt-arms-sequential.mjs";
import { shellQuote } from "./lib/shell.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Fake `node` that logs its argv and exits with $FAKE_NODE_EXIT. */
function fakeNodeBin(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "node"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_NODE_LOG"\ncase "$*" in *case-study-coding.mjs*) exit "${FAKE_NODE_EXIT:-0}";; esac\nexit 0\n',
  );
  chmodSync(join(bin, "node"), 0o755);
  return bin;
}

function bash(script, env) {
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
}

describe("shellQuote", () => {
  it("turns hostile values into single literal words", () => {
    for (const v of ["plain", "a b", "x'y", "$(touch pwned)", "a;b|c&d", "`id`", "", "--tasks=1,2"]) {
      const r = bash(`printf '%s' ${shellQuote(v)}`);
      assert.equal(r.stdout, v);
    }
  });
});

describe("kit-tmux-shard", () => {
  let tmp = "";
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "fausth-tmux-"));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("reports the runner's exit status (pipefail) and quotes task ids", () => {
    const bin = fakeNodeBin(tmp);
    mkdirSync(join(tmp, "live/reports/kit-probe"), { recursive: true });
    const cmd = shardCommand(
      { runId: "probe-l1-glm", models: ["kit.glm-5.3-flash"], tasks: ["01-fix-add;touch PWNED"], reps: 1 },
      { manifest: "case-studies/x manifest.yml", skipConformance: true, conditions: ["counterbalanced"] },
      `cd ${shellQuote(tmp)} || exit 97`,
    );
    const r = bash(cmd, {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_NODE_LOG: join(tmp, "node.log"),
      FAKE_NODE_EXIT: "3",
    });
    const log = readFileSync(join(tmp, "live/reports/kit-probe/probe-l1-glm.log"), "utf8");
    assert.match(log, /EXIT:3/, `${r.stdout}\n${r.stderr}`);
    assert.ok(!existsSync(join(tmp, "PWNED")), "task ids must not be executable");
    const argv = readFileSync(join(tmp, "node.log"), "utf8");
    assert.match(argv, /--tasks 01-fix-add;touch PWNED/);
    assert.match(argv, /--manifest case-studies\/x manifest\.yml/);
  });

  it("does not run when the activation fails", () => {
    const bin = fakeNodeBin(tmp);
    const cmd = shardCommand(
      { runId: "probe-l1-glm", models: ["kit.glm-5.3-flash"], tasks: ["t"], reps: 1 },
      { manifest: "m.yml" },
      `cd ${shellQuote(join(tmp, "missing-dir"))} || exit 97`,
    );
    const r = bash(cmd, { PATH: `${bin}:${process.env.PATH}`, FAKE_NODE_LOG: join(tmp, "node2.log") });
    assert.equal(r.status, 97);
    assert.ok(!existsSync(join(tmp, "node2.log")), "runner must not start");
  });

  it("aggregates only the prefix's own run directories", () => {
    const base = join(tmp, "repo");
    const runs = join(base, "live/reports/case-studies/coding-counterbalance");
    for (const d of ["kit-probe-l1-glm", "kit-probe-v2-l1-glm", "old-kit-probe-l1-glm", "kit-probe-l1-glm-extra"]) {
      mkdirSync(join(runs, d), { recursive: true });
    }
    mkdirSync(join(base, "live/reports/kit-probe"), { recursive: true });
    writeFileSync(
      join(base, "live/reports/kit-probe/kit-probe-l1-shards.json"),
      JSON.stringify({ shards: [{ runId: "kit-probe-l1-glm" }] }),
    );
    writeFileSync(join(base, "live/reports/kit-probe/kit-probe-v2-l1-shards.json"), JSON.stringify({ shards: [] }));
    const dirs = resolveRawDirs("kit-probe", base);
    assert.deepEqual(dirs, [
      join(runs, "kit-probe-l1-glm"),
      join(base, "live/reports/kit-probe/kit-probe-l1-shards.json"),
    ]);
  });
});

describe("opt-arms launchers", () => {
  let tmp = "";
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "fausth-optarms-"));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("quotes arm commands and reports the runner status", () => {
    const bin = fakeNodeBin(tmp);
    const cmd = buildCommand(
      {
        manifest: "case-studies/swe-bench/manifest-optimize.yml",
        condition: "cb-mutable",
        runId: "hri-swe-opt-arms-v9-mutable",
        extra: ["--max-task-tries", "5"],
      },
      { model: "kit.glm-5.3-flash", activate: `cd ${shellQuote(tmp)} || exit 97`, logDir: tmp },
    );
    bash(cmd, { PATH: `${bin}:${process.env.PATH}`, FAKE_NODE_LOG: join(tmp, "n.log"), FAKE_NODE_EXIT: "5" });
    assert.match(readFileSync(join(tmp, "hri-swe-opt-arms-v9-mutable.log"), "utf8"), /EXIT:5/);
  });

  it("rejects run prefixes that are not plain tags", () => {
    assert.equal(validateRunPrefix("v3"), "v3");
    assert.throws(() => validateRunPrefix("v3; rm -rf ~"), /run prefix/);
    assert.throws(() => sequentialScript("$(id)"), /run prefix/);
    const script = sequentialScript("v4", { activate: "true", arms: ["baseline"] });
    assert.match(script, /--run-prefix v4 --track swe --arm baseline/);
    assert.match(script, /--prefixes v2,v4/);
  });
});

describe("track-s-measure.sh", () => {
  it("launches the opt-arms chain even when the django smoke fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fausth-tracks-"));
    try {
      mkdirSync(join(tmp, "repo", "scripts"), { recursive: true });
      copyFileSync(join(here, "track-s-measure.sh"), join(tmp, "repo", "scripts", "track-s-measure.sh"));
      const bin = fakeNodeBin(tmp);
      const r = spawnSync("bash", [join(tmp, "repo", "scripts", "track-s-measure.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_NODE_LOG: join(tmp, "node.log"),
          FAKE_NODE_EXIT: "4",
        },
      });
      const log = readFileSync(join(tmp, "repo", "live/reports/kit-probe/track-s-measure.log"), "utf8");
      assert.match(log, /DJANGO_EXIT:4/);
      assert.match(log, /MEASURE_CHAIN_LAUNCHED/);
      assert.match(readFileSync(join(tmp, "node.log"), "utf8"), /opt-arms-sequential\.mjs launch/);
      assert.match(readFileSync(join(tmp, "node.log"), "utf8"), /--kit-models kit\.glm-5\.3-flash/);
      assert.equal(r.status, 4, "exit reports the smoke status");
      assert.ok(!existsSync(join(tmp, "repo", "case-studies")), "nothing copied into results/");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
