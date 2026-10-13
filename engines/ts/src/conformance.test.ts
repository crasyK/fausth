/**
 * Conformance suite checks (spec-v0.3 §13, §15.4; SPEC-4, D12):
 * every fixture's agent.json validates, has no judge verify, replays byte-identically, and every
 * stage / verdict / reason / failure kind it emits is in the closed lists that the spec text
 * documents.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listFixtureDirs, loadAgentDir } from "./load.js";
import { validateAgent } from "./validate.js";
import { replayFixtureDir } from "./replay.js";
import { FAILURE_KINDS, REASON_CODES, STAGES, VERDICTS, type Event } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = listFixtureDirs(join(root, "conformance/fixtures"));
const spec = readFileSync(join(root, "docs/spec-v0.3.md"), "utf8");

describe("conformance fixtures", () => {
  it("there are fixtures", () => {
    assert.ok(fixtures.length >= 50, `found ${fixtures.length}`);
  });

  for (const dir of fixtures) {
    const name = basename(dir);
    it(`${name}: agent validates and has no judge verify`, () => {
      const agent = loadAgentDir(dir).agent;
      const v = validateAgent(agent);
      assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
      const judges = agent.tools.flatMap((t) => t.verify ?? []).filter((x) => x.kind === "judge");
      assert.equal(judges.length, 0, "judge verifies are live-only (Track A)");
      assert.notEqual(agent.recovery?.verify.kind, "judge");
    });

    it(`${name}: replays byte-identically with closed vocabularies`, async () => {
      const r = await replayFixtureDir(dir);
      assert.equal(r.actual, r.expected, `golden mismatch for ${name}`);
      const events = r.actual
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Event);
      for (const e of events) {
        assert.ok((STAGES as readonly string[]).includes(e.stage), `stage ${e.stage}`);
        if (e.verdict !== undefined) assert.ok((VERDICTS as readonly string[]).includes(e.verdict), `verdict ${e.verdict}`);
        if (e.reason !== undefined) assert.ok((REASON_CODES as readonly string[]).includes(e.reason), `reason ${e.reason}`);
        if (e.failure !== undefined) {
          assert.ok((FAILURE_KINDS as readonly string[]).includes(e.failure.kind), `failure.kind ${e.failure.kind}`);
        }
      }
    });
  }
});

describe("the spec documents every closed code (D12)", () => {
  it("every reason code is listed in spec-v0.3 §13.2", () => {
    for (const code of REASON_CODES) assert.ok(spec.includes(`| \`${code}\` |`), `reason ${code} missing from spec table`);
  });
  it("every failure kind is listed in spec-v0.3 §13.3", () => {
    for (const kind of FAILURE_KINDS) assert.ok(spec.includes(`| \`${kind}\` |`), `failure.kind ${kind} missing from spec table`);
  });
  it("every stage is listed in spec-v0.3 §13.1", () => {
    for (const stage of STAGES) assert.ok(spec.includes(`\`${stage}\``), `stage ${stage} missing from spec`);
  });
});
