/** SCR-20: one shared .env loader (was copied three times). */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDotEnv, parseDotEnv } from "./lib/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("dotenv loader", () => {
  it("parses quotes, export prefixes and comments", () => {
    assert.deepEqual(
      parseDotEnv('# c\nA=1\nexport B="two words"\nC=\'x=y\'\n bad line\n9X=no\nD=\n'),
      { A: "1", B: "two words", C: "x=y", D: "" },
    );
  });

  it("never overrides variables that are already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "KEEP=file\nNEW=file\n");
      const env = { KEEP: "process" };
      assert.deepEqual(loadDotEnv(file, env), ["NEW"]);
      assert.deepEqual(env, { KEEP: "process", NEW: "file" });
      assert.deepEqual(loadDotEnv(join(dir, "absent"), env), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("host scripts no longer carry private copies of the loader", () => {
    for (const f of ["case-study-coding.mjs", "kit-tmux-shard.mjs", "live-mcp-model.mjs"]) {
      const src = readFileSync(join(here, f), "utf8");
      assert.doesNotMatch(src, /function loadDotEnv|function loadDotEnvQuiet/, f);
    }
  });
});
