import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("fausth bin (CORE-4)", () => {
  it("runs the current sources from any working directory (cannot go stale)", () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { bin: Record<string, string>; version: string };
    assert.equal(pkg.bin.fausth, "./bin/fausth.mjs");
    const r = spawnSync(process.execPath, [join(pkgDir, "bin/fausth.mjs"), "--version"], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `fausth ${pkg.version}`);
  });
});
