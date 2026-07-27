import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkRunTitle,
  findingsToAnnotations,
  collectFindings,
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
