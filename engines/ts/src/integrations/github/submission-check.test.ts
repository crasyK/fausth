import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runSubmissionCheck,
  verifyFindingEvidence,
  filterVerifiedFindings,
  redactSecrets,
  containsSecret,
  FINDING_REJECT_REASONS,
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

  it("accepts Readme.txt with Setup/Demo headings", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/Readme.txt", "projects/demo/app.js"],
      file_contents: {
        "projects/demo/Readme.txt": "# Demo\n\n## Setup\n\nx\n\n## Demo\n\ny\n",
        "projects/demo/app.js": "console.log(1)",
      },
    });
    assert.equal(packet.conclusion, "pass");
  });

  it("accepts readme.md (lowercase) as the project README", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/readme.md"],
      file_contents: {
        "projects/demo/readme.md": goodReadme,
      },
    });
    assert.equal(packet.conclusion, "pass");
  });

  it("prefers README.md over Readme.txt when both exist", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md", "projects/demo/Readme.txt"],
      file_contents: {
        "projects/demo/README.md": goodReadme,
        "projects/demo/Readme.txt": "# Bad\n\nno sections\n",
      },
    });
    assert.equal(packet.conclusion, "pass");
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
          severity: "warning",
          path: "secrets/x",
          evidence: "x",
          recommendation: "no",
        },
      ],
      packet,
    );
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.reason, "path_not_in_packet");
  });
});

// ---------------------------------------------------------------------------
// Regression tests (audit 2026-10-12): EDGE-3 redaction, EDGE-15 strict gate,
// EDGE-17 demo "not available" note.
// Token-shaped values are assembled at runtime so no literal secret shapes live in source.
// ---------------------------------------------------------------------------

const FAKE_PASSWORD = "hunter2".repeat(3); // 21 chars
const FAKE_GH_TOKEN = "ghp_" + "Fake0".repeat(8);
const FAKE_AWS_KEY = "AKIA" + "FAKE".repeat(4);
const FAKE_SK = "sk-or-v1-" + "abc123".repeat(6);

function allOutputText(packet: ReviewPacket): string {
  return JSON.stringify({
    findings: packet.deterministic_findings,
    files: packet.files,
  });
}

describe("secret redaction (EDGE-3)", () => {
  it("never echoes key=value secrets or token shapes in findings or packet files", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: [
        "projects/demo/README.md",
        "projects/demo/config.yml",
        "projects/demo/deploy.sh",
        "projects/demo/.env",
      ],
      file_contents: {
        "projects/demo/README.md": goodReadme,
        "projects/demo/config.yml": `db:\n  password: ${FAKE_PASSWORD}\n`,
        "projects/demo/deploy.sh": `export GH=${FAKE_GH_TOKEN}\nexport AWS=${FAKE_AWS_KEY}\n`,
        "projects/demo/.env": `OPENROUTER=${FAKE_SK}\n`,
      },
    });
    assert.equal(packet.conclusion, "fail");
    const secretFindings = packet.deterministic_findings.filter((f) => f.category === "potential_secret");
    assert.deepEqual(
      secretFindings.map((f) => f.path).sort(),
      ["projects/demo/.env", "projects/demo/config.yml", "projects/demo/deploy.sh"],
    );
    const text = allOutputText(packet);
    for (const secret of [FAKE_PASSWORD, FAKE_GH_TOKEN, FAKE_AWS_KEY, FAKE_SK]) {
      assert.equal(text.includes(secret), false, `secret leaked: ${secret.slice(0, 6)}…`);
    }
    // Evidence still says what was found, without the value.
    const cfg = secretFindings.find((f) => f.path.endsWith("config.yml"))!;
    assert.match(cfg.evidence, /password/i);
    assert.match(cfg.evidence, /\[REDACTED/);
  });

  it("redacts secrets inside README-derived evidence (missing-instructions slice)", () => {
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md"],
      file_contents: {
        // No Setup / Demo headings → missing_instructions evidence = README head.
        "projects/demo/README.md": `# Demo\napi_key = ${FAKE_PASSWORD}\ntoken: ${FAKE_GH_TOKEN}\n`,
      },
    });
    assert.ok(packet.deterministic_findings.some((f) => f.category === "missing_instructions"));
    const text = allOutputText(packet);
    assert.equal(text.includes(FAKE_PASSWORD), false);
    assert.equal(text.includes(FAKE_GH_TOKEN), false);
  });

  it("does not leave a partial secret when the evidence slice cuts through it", () => {
    const pad = "x".repeat(100);
    const packet = runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md"],
      file_contents: { "projects/demo/README.md": `# ${pad}\n${FAKE_GH_TOKEN}\n` },
    });
    const text = allOutputText(packet);
    assert.equal(text.includes(FAKE_GH_TOKEN.slice(0, 12)), false);
  });

  it("redactSecrets replaces every match, private key blocks and bearer tokens", () => {
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA" + "q".repeat(40), "-----END RSA PRIVATE KEY-----"].join("\n");
    const input = `a ${FAKE_GH_TOKEN} b ${FAKE_GH_TOKEN} c\nAuthorization: Bearer ${"tok3n".repeat(5)}\n${pem}\nxoxb-${"1234567890"}-${"abcdefghij"}`;
    const out = redactSecrets(input);
    assert.equal(out.includes(FAKE_GH_TOKEN), false);
    assert.equal(out.includes("tok3n".repeat(5)), false);
    assert.equal(out.includes("MIIEowIBAAKCAQEA"), false);
    assert.equal(out.includes("xoxb-1234567890"), false);
    assert.match(out, /Bearer \[REDACTED/);
    assert.equal(containsSecret("just prose, nothing secret"), false);
    assert.equal(redactSecrets("just prose, nothing secret"), "just prose, nothing secret");
  });
});

describe("strict evidence gate (EDGE-15)", () => {
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
  const base = {
    category: "missing_instructions" as const,
    severity: "warning" as const,
    path: "projects/demo/README.md",
    evidence: "## Setup",
    recommendation: "ok",
  };
  const reasonOf = (f: unknown): string | undefined => {
    const v = verifyFindingEvidence(f as Parameters<typeof verifyFindingEvidence>[0], packet);
    return v.ok ? undefined : v.reason;
  };

  it("rejects empty or whitespace evidence", () => {
    assert.equal(reasonOf({ ...base, evidence: "" }), "evidence_empty");
    assert.equal(reasonOf({ ...base, evidence: "   \n" }), "evidence_empty");
  });

  it("rejects non-integer, NaN and out-of-range line_start", () => {
    assert.equal(reasonOf({ ...base, line_start: Number.NaN }), "line_invalid");
    assert.equal(reasonOf({ ...base, line_start: 2.5 }), "line_invalid");
    assert.equal(reasonOf({ ...base, line_start: 0 }), "line_out_of_range");
    assert.equal(reasonOf({ ...base, line_start: 999 }), "line_out_of_range");
    assert.equal(reasonOf({ ...base, line_start: 3 }), undefined);
  });

  it("rejects categories and severities outside the closed enums", () => {
    assert.equal(reasonOf({ ...base, category: "style_nit" }), "invalid_category");
    assert.equal(reasonOf({ ...base, severity: "critical" }), "invalid_severity");
  });

  it("reserves blocking severity for the deterministic layer", () => {
    assert.equal(reasonOf({ ...base, severity: "blocking" }), "severity_reserved_for_deterministic");
  });

  it("rejects empty recommendation", () => {
    assert.equal(reasonOf({ ...base, recommendation: " " }), "recommendation_empty");
  });

  it("every rejection reason is in the exported closed set", () => {
    for (const f of [
      { ...base, evidence: "" },
      { ...base, line_start: Number.NaN },
      { ...base, category: "x" },
      { ...base, severity: "x" },
      { ...base, severity: "blocking" },
      { ...base, path: "projects/nope.md" },
      { ...base, evidence: "absent" },
    ]) {
      const r = reasonOf(f);
      assert.ok(r && (FINDING_REJECT_REASONS as readonly string[]).includes(r), `unknown reason ${r}`);
    }
  });
});

describe("demo not-available note (EDGE-17)", () => {
  const withSetupOnly = (extra: string) =>
    runSubmissionCheck({
      pr_body: goodBody,
      changed_paths: ["projects/demo/README.md"],
      file_contents: {
        "projects/demo/README.md": `# My Project\n\n## Setup\n\nnpm install\n\n${extra}\n`,
      },
    });
  const missingDemo = (p: ReviewPacket) =>
    p.deterministic_findings.some(
      (f) => f.category === "missing_instructions" && /Demo/.test(f.recommendation),
    );

  it("a bare 'none' / 'n/a' elsewhere does not waive the Demo section", () => {
    assert.equal(missingDemo(withSetupOnly("Config: none of the env vars are required.")), true);
    assert.equal(missingDemo(withSetupOnly("License: n/a")), true);
  });

  it("an explicit demo-specific note waives it", () => {
    assert.equal(missingDemo(withSetupOnly("Demo: n/a")), false);
    assert.equal(missingDemo(withSetupOnly("Demo link: not available")), false);
    assert.equal(missingDemo(withSetupOnly("No demo available (hardware-only project).")), false);
    assert.equal(missingDemo(withSetupOnly("The demo is not available yet.")), false);
  });
});
