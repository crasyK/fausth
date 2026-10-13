/**
 * Regression tests (audit 2026-10-12) for the advisory review tools:
 * EDGE-15 strict finding.submit validation, EDGE-3 redaction in rendered markdown/prompt.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAdvisoryPrompt,
  createReviewTools,
  formatReviewMarkdown,
  type ReviewToolState,
} from "./review-runtime.js";
import type { ReviewPacket } from "./submission-check.js";

const FAKE_GH_TOKEN = "ghp_" + "Fake0".repeat(8);

function packet(content: string): ReviewPacket {
  return {
    pr_title: "Add demo",
    changed_paths: ["projects/demo/README.md"],
    files: [{ path: "projects/demo/README.md", content, included: true }],
    byte_budget: 1000,
    bytes_included: content.length,
    redacted: [],
    deterministic_findings: [],
    conclusion: "pass",
    prompt_contract_version: "t",
    created_at: "t",
  };
}

async function submit(state: ReviewToolState, args: Record<string, unknown>) {
  const tools = createReviewTools(state);
  const r = (await tools["finding.submit"]!(args, { state: {} })) as {
    output: { accepted: number; verified: number; reason?: string };
  };
  return r.output;
}

const valid = {
  category: "contradiction",
  severity: "warning",
  path: "projects/demo/README.md",
  evidence: "No API keys required",
  recommendation: "Resolve the API key contradiction.",
};

describe("finding.submit strict validation (EDGE-15)", () => {
  const content = "# Demo\n\n## Setup\nNo API keys required\nvalue is undefined here\n\n## Demo\nrun\n";

  it("accepts a valid advisory finding", async () => {
    const state: ReviewToolState = { packet: packet(content), aiFindings: [] };
    const out = await submit(state, valid);
    assert.equal(out.accepted, 1);
    assert.equal(state.aiFindings.length, 1);
  });

  it("missing evidence is not coerced to the string 'undefined'", async () => {
    const state: ReviewToolState = { packet: packet(content), aiFindings: [] };
    const { evidence: _e, ...noEvidence } = valid;
    const out = await submit(state, noEvidence);
    assert.equal(out.accepted, 0);
    assert.equal(out.reason, "evidence_empty");
    assert.equal(state.aiFindings.length, 0);
  });

  it("non-integer line_start is rejected (no NaN pass-through)", async () => {
    const state: ReviewToolState = { packet: packet(content), aiFindings: [] };
    assert.equal((await submit(state, { ...valid, line_start: "abc" })).reason, "line_invalid");
    assert.equal((await submit(state, { ...valid, line_start: 1.5 })).reason, "line_invalid");
    assert.equal(state.aiFindings.length, 0);
  });

  it("unknown category / severity are rejected instead of cast", async () => {
    const state: ReviewToolState = { packet: packet(content), aiFindings: [] };
    assert.equal((await submit(state, { ...valid, category: "bogus" })).reason, "invalid_category");
    assert.equal((await submit(state, { ...valid, severity: "critical" })).reason, "invalid_severity");
    assert.equal((await submit(state, { ...valid, severity: 3 })).reason, "invalid_severity");
    assert.equal(state.aiFindings.length, 0);
  });

  it("the advisory layer cannot submit blocking severity", async () => {
    const state: ReviewToolState = { packet: packet(content), aiFindings: [] };
    const out = await submit(state, { ...valid, severity: "blocking" });
    assert.equal(out.accepted, 0);
    assert.equal(out.reason, "severity_reserved_for_deterministic");
  });

  it("non-string recommendation / path are rejected", async () => {
    const state: ReviewToolState = { packet: packet(content), aiFindings: [] };
    assert.equal((await submit(state, { ...valid, recommendation: 42 })).reason, "recommendation_empty");
    assert.equal((await submit(state, { ...valid, path: ["x"] })).reason, "invalid_path");
  });
});

describe("rendering redaction (EDGE-3)", () => {
  it("formatReviewMarkdown never prints secrets from AI findings or dropped paths", () => {
    const md = formatReviewMarkdown({
      mode: "advisory",
      conclusion: "action_required",
      deterministic: packet("x"),
      ai_findings: [
        {
          category: "safety_concern",
          severity: "warning",
          path: "projects/demo/README.md",
          evidence: `token=${FAKE_GH_TOKEN}`,
          recommendation: `Rotate ${FAKE_GH_TOKEN}`,
        },
      ],
      dropped_findings: [
        {
          finding: {
            category: "human_review",
            severity: "info",
            path: `projects/${FAKE_GH_TOKEN}.md`,
            evidence: "x",
            recommendation: "x",
          },
          reason: "path_not_in_packet",
        },
      ],
    });
    assert.equal(md.includes(FAKE_GH_TOKEN), false);
    assert.match(md, /REDACTED/);
  });

  it("buildAdvisoryPrompt redacts the PR title and states the severity policy", () => {
    const p = packet("# Demo\n");
    p.pr_title = `leak ${FAKE_GH_TOKEN}`;
    const { system, user } = buildAdvisoryPrompt(p);
    assert.equal(user.includes(FAKE_GH_TOKEN), false);
    assert.match(system, /blocking is reserved/i);
  });
});
