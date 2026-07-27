import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runSubmissionCheck,
  verifyFindingEvidence,
  filterVerifiedFindings,
  type ReviewPacket,
} from "./submission-check.js";

const goodReadme = `# My Project

## Setup

npm install

## Demo

npm start
`;

const goodBody = `## Project
**Name:** demo
## Submission check
- [x] Our project lives inside one folder under \`projects\`.
- [x] We completed the project \`README.md\`.
- [x] We included setup and demo instructions.
- [x] We did not commit passwords, API keys, tokens or private data.
- [x] We have permission to publish the submitted code and assets.
`;

describe("runSubmissionCheck", () => {
  it("passes a minimal good submission", () => {
    const packet = runSubmissionCheck({
      pr_title: "Add demo",
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md", "projects/demo/src/app.ts"],
      file_contents: {
        "projects/demo/README.md": goodReadme,
        "projects/demo/src/app.ts": "export {}",
      },
    });
    assert.equal(packet.conclusion, "pass");
    assert.equal(packet.deterministic_findings.length, 0);
  });

  it("fails when README missing", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/src/app.ts"],
      file_contents: { "projects/demo/src/app.ts": "export {}" },
    });
    assert.equal(packet.conclusion, "fail");
    assert.ok(packet.deterministic_findings.some((f) => f.path.includes("README")));
  });

  it("fails on two project folders", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/a/README.md", "projects/b/README.md"],
      file_contents: {
        "projects/a/README.md": goodReadme,
        "projects/b/README.md": goodReadme,
      },
    });
    assert.equal(packet.conclusion, "fail");
    assert.ok(packet.deterministic_findings.some((f) => f.category === "scope_violation"));
  });

  it("fails on out-of-scope changes", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md", "package.json"],
      file_contents: { "projects/demo/README.md": goodReadme },
    });
    assert.equal(packet.conclusion, "fail");
    assert.ok(packet.deterministic_findings.some((f) => f.path === "package.json"));
  });

  it("fails unchecked template boxes", () => {
    const packet = runSubmissionCheck({
      pr_body: `## Submission check\n- [ ] Our project lives inside one folder under \`projects\`.\n- [ ] We completed the project \`README.md\`.\n- [ ] We included setup and demo instructions.\n- [ ] We did not commit passwords, API keys, tokens or private data.\n- [ ] We have permission to publish the submitted code and assets.\n`,
      changed_paths: ["projects/demo/README.md"],
      file_contents: { "projects/demo/README.md": goodReadme },
    });
    assert.equal(packet.conclusion, "fail");
  });

  it("accepts checked boxes with projects/ trailing slash", () => {
    const packet = runSubmissionCheck({
      pr_body: `## Submission check\n- [x] Our project lives inside one folder under \`projects/\`.\n- [x] We completed the project \`README.md\`.\n- [x] We included setup and demo instructions.\n- [x] We did not commit passwords, API keys, tokens or private data.\n- [x] We have permission to publish the submitted code and assets.\n`,
      changed_paths: ["projects/demo/README.md"],
      file_contents: { "projects/demo/README.md": goodReadme },
    });
    assert.equal(packet.conclusion, "pass");
  });

  it("fails on secret-like content", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md", "projects/demo/.env"],
      file_contents: {
        "projects/demo/README.md": goodReadme,
        "projects/demo/.env": "OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789",
      },
    });
    assert.equal(packet.conclusion, "fail");
    assert.ok(packet.deterministic_findings.some((f) => f.category === "potential_secret"));
    assert.ok(packet.redacted.includes("projects/demo/.env"));
  });

  it("fails path traversal", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/../../etc/passwd"],
      file_contents: {},
    });
    assert.equal(packet.conclusion, "fail");
  });

  it("fails missing setup heading", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md"],
      file_contents: {
        "projects/demo/README.md": "# Demo\n\n## Demo\n\nrun it\n",
      },
    });
    assert.equal(packet.conclusion, "fail");
    assert.ok(packet.deterministic_findings.some((f) => f.category === "missing_instructions"));
  });

  it("excludes binary by extension", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md", "projects/demo/shot.png"],
      file_contents: {
        "projects/demo/README.md": goodReadme,
        "projects/demo/shot.png": "fakepng",
      },
    });
    const png = packet.files.find((f) => f.path.endsWith(".png"));
    assert.ok(png);
    assert.equal(png!.included, false);
    assert.equal(png!.exclude_reason, "binary_extension");
  });
});

describe("verifyFindingEvidence", () => {
  const packet: ReviewPacket = {
    changed_paths: ["projects/demo/README.md"],
    files: [
      {
        path: "projects/demo/README.md",
        content: "# X\n\n## Setup\nnpm i\n\n## Demo\nok\n",
        included: true,
      },
    ],
    byte_budget: 1000,
    bytes_included: 10,
    redacted: [],
    deterministic_findings: [],
    conclusion: "pass",
    prompt_contract_version: "t",
    created_at: "t",
  };

  it("accepts valid citation", () => {
    const v = verifyFindingEvidence(
      {
        category: "missing_instructions",
        severity: "warning",
        path: "projects/demo/README.md",
        line_start: 3,
        evidence: "## Setup",
        recommendation: "ok",
      },
      packet,
    );
    assert.equal(v.ok, true);
  });

  it("rejects bad path", () => {
    const v = verifyFindingEvidence(
      {
        category: "missing_instructions",
        severity: "warning",
        path: "projects/other/README.md",
        evidence: "## Setup",
        recommendation: "x",
      },
      packet,
    );
    assert.equal(v.ok, false);
  });

  it("rejects bad snippet", () => {
    const v = verifyFindingEvidence(
      {
        category: "missing_instructions",
        severity: "warning",
        path: "projects/demo/README.md",
        evidence: "THIS_IS_NOT_THERE",
        recommendation: "x",
      },
      packet,
    );
    assert.equal(v.ok, false);
  });

  it("filterVerifiedFindings drops bad", () => {
    const { kept, dropped } = filterVerifiedFindings(
      [
        {
          category: "human_review",
          severity: "info",
          path: "projects/demo/README.md",
          evidence: "## Demo",
          recommendation: "ok",
        },
        {
          category: "scope_violation",
          severity: "blocking",
          path: "secrets/x",
          evidence: "x",
          recommendation: "no",
        },
      ],
      packet,
    );
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
  });
});
