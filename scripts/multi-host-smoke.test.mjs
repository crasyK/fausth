/** SCR-20: the golden's existence is checked before it is read. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compareToGolden } from "./multi-host-smoke.mjs";

describe("multi-host golden comparison", () => {
  it("reports a missing golden instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-mh-"));
    try {
      writeFileSync(join(dir, "ts.jsonl"), "a\n");
      writeFileSync(join(dir, "py.jsonl"), "a\n");
      const r = compareToGolden({
        goldenPath: join(dir, "missing.jsonl"),
        tsDump: join(dir, "ts.jsonl"),
        pyDump: join(dir, "py.jsonl"),
      });
      assert.equal(r.ok, false);
      assert.match(r.messages[0], /missing golden/);
      writeFileSync(join(dir, "golden.jsonl"), "a\r\n");
      const ok = compareToGolden({
        goldenPath: join(dir, "golden.jsonl"),
        tsDump: join(dir, "ts.jsonl"),
        pyDump: join(dir, "py.jsonl"),
      });
      assert.equal(ok.ok, true, ok.messages.join("; "));
      writeFileSync(join(dir, "py.jsonl"), "b\n");
      assert.equal(
        compareToGolden({ goldenPath: join(dir, "golden.jsonl"), tsDump: join(dir, "ts.jsonl"), pyDump: join(dir, "py.jsonl") }).ok,
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
