import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkRunTitle,
  findingsToAnnotations,
  collectFindings,
  escapeWorkflowData,
  escapeWorkflowProperty,
  githubActionsCommandLines,
  outboundMarkdown,
} from "./poster.js";
import type { ReviewReport } from "./review-runtime.js";
import type { ReviewPacket } from "./submission-check.js";

function emptyPacket(findings: ReviewPacket["deterministic_findings"] = []): ReviewPacket {
  return {
    changed_paths: ["projects/demo/README.md"],
    files: [],
    byte_budget: 0,
    bytes_included: 0,
    redacted: [],
    deterministic_findings: findings,
    conclusion: findings.some((f) => f.severity === "blocking") ? "fail" : "pass",
    prompt_contract_version: "test",
    created_at: new Date().toISOString(),
  };
}

function baseReport(partial: Partial<ReviewReport>): ReviewReport {
  return {
    mode: "deterministic",
    conclusion: "pass",
    deterministic: emptyPacket(),
    ai_findings: [],
    markdown: "## Faust\n",
    ...partial,
  };
}

describe("poster check titles / annotations", () => {
  it("titles a single finding with category and recommendation", () => {
    const report = baseReport({
      conclusion: "fail",
      deterministic: emptyPacket([
        {
          category: "missing_instructions",
          severity: "blocking",
          path: "projects/demo/README.md",
          line_start: 1,
          evidence: "no Setup",
          recommendation: "Add a Setup section with install steps.",
        },
      ]),
    });
    assert.match(checkRunTitle(report), /^missing_instructions:/);
    assert.equal(collectFindings(report).length, 1);
    const ann = findingsToAnnotations(collectFindings(report));
    assert.equal(ann[0]?.annotation_level, "failure");
    assert.equal(ann[0]?.path, "projects/demo/README.md");
    assert.match(ann[0]?.message ?? "", /Setup/);
  });

  it("summarizes multiple issues in the check title", () => {
    const report = baseReport({
      mode: "advisory",
      conclusion: "action_required",
      ai_findings: [
        {
          category: "contradiction",
          severity: "blocking",
          path: "projects/demo/README.md",
          evidence: "no keys vs token",
          recommendation: "Resolve API key contradiction.",
        },
        {
          category: "safety_concern",
          severity: "blocking",
          path: "projects/demo/README.md",
          evidence: "disable auth",
          recommendation: "Do not disable authentication.",
        },
      ],
    });
    assert.equal(checkRunTitle(report), "2 issues — contradiction, safety_concern");
  });

  it("pass title when no findings", () => {
    assert.equal(checkRunTitle(baseReport({ conclusion: "pass" })), "Pass — no issues");
  });
});

// ---------------------------------------------------------------------------
// Regression tests (audit 2026-10-12): EDGE-16 workflow-command injection,
// EDGE-3 redaction on every outbound channel.
// ---------------------------------------------------------------------------

const FAKE_GH_TOKEN = "ghp_" + "Fake0".repeat(8);

describe("workflow command escaping (EDGE-16)", () => {
  it("escapes property values and message data per the GitHub spec", () => {
    assert.equal(escapeWorkflowData("50% done\r\nnext"), "50%25 done%0D%0Anext");
    assert.equal(
      escapeWorkflowProperty("projects/a,b::c%0A.md\n"),
      "projects/a%2Cb%3A%3Ac%250A.md%0A",
    );
  });

  it("a hostile filename / category cannot inject a second command", () => {
    const report = baseReport({
      conclusion: "fail",
      deterministic: emptyPacket([
        {
          category: "scope_violation\n::error file=x::pwned" as never,
          severity: "blocking",
          path: "projects/a,b::c%0A.md\n::warning::injected",
          line_start: Number.NaN,
          evidence: "x",
          recommendation: "Do not change files outside projects/demo/.",
        },
      ]),
    });
    const lines = githubActionsCommandLines(report);
    assert.equal(lines.length, 1);
    const line = lines[0]!;
    assert.equal(/[\r\n]/.test(line), false);
    // Exactly one command, at the start; its property section has exactly 3 keys.
    assert.equal(line.indexOf("::error "), 0);
    const rest = line.slice("::error ".length);
    const props = rest.slice(0, rest.indexOf("::"));
    assert.deepEqual(
      props.split(",").map((kv) => kv.split("=")[0]),
      ["file", "line", "title"],
    );
    assert.match(line, /file=projects\/a%2Cb%3A%3Ac%250A\.md%0A%3A%3Awarning%3A%3Ainjected,/);
    assert.match(line, /,line=1,/);
    // Whitespace (incl. the injected newline) is collapsed, ':' / ',' are escaped.
    assert.match(line, /title=scope_violation %3A%3Aerror file=x%3A%3Apwned::/);
  });

  it("conclusion summary line is escaped too", () => {
    const report = baseReport({ conclusion: "infrastructure_error" });
    const lines = githubActionsCommandLines(report);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^::error title=infrastructure_error::/);
  });
});

describe("outbound redaction (EDGE-3)", () => {
  const leaky = baseReport({
    mode: "advisory",
    conclusion: "action_required",
    markdown: `## Faust\n\nError: upstream said token=${FAKE_GH_TOKEN}\n`,
    ai_findings: [
      {
        category: "safety_concern",
        severity: "warning",
        path: "projects/demo/README.md",
        line_start: 2,
        evidence: `uses ${FAKE_GH_TOKEN}`,
        recommendation: `Rotate ${FAKE_GH_TOKEN} now.`,
      },
    ],
  });

  it("annotations, check-run title and outbound markdown never carry the token", () => {
    const ann = findingsToAnnotations(collectFindings(leaky));
    assert.equal(JSON.stringify(ann).includes(FAKE_GH_TOKEN), false);
    assert.equal(checkRunTitle(leaky).includes(FAKE_GH_TOKEN), false);
    assert.equal(githubActionsCommandLines(leaky).join("\n").includes(FAKE_GH_TOKEN), false);
    assert.equal(outboundMarkdown(leaky).includes(FAKE_GH_TOKEN), false);
    assert.match(outboundMarkdown(leaky), /REDACTED/);
  });
});
