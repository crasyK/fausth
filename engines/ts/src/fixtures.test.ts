import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replayDir } from "./node.js";

// Every conformance fixture must replay to both expected files byte for byte (spec §14).
const root = fileURLToPath(new URL("../../../conformance/fixtures/", import.meta.url));

for (const name of readdirSync(root).sort()) {
  test(`fixture ${name}`, async () => {
    const out = await replayDir(root + name);
    assert.equal(out.log, readFileSync(`${root}${name}/expected.log.jsonl`, "utf8"), "expected.log.jsonl");
    assert.equal(out.requests, readFileSync(`${root}${name}/expected.requests.jsonl`, "utf8"), "expected.requests.jsonl");
  });
}
