import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  ConnectorError,
  resolveHarness,
  resolvedHarnessCanonicalJson,
  resolvedHarnessHash,
} from "./resolve.js";
import { inspectHarness, testHarness } from "../packaging.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const example = join(root, "examples/primitives/inline-file-connectors");
const coding = join(root, "examples/coding-counterbalance");

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("connector resolve", () => {
  it("identity-resolves legacy harnesses with empty lock", () => {
    const resolved = resolveHarness(coding);
    assert.equal(resolved.format, "fausth-resolved-harness/v0.1");
    assert.equal(resolved.agent.name, "coding-counterbalance-slice");
    assert.deepEqual(resolved.resolution.connectors, []);
    assert.deepEqual(resolved.resolution.selected, []);
    assert.deepEqual(resolved.resolution.lock, []);
    const again = resolveHarness(coding);
    assert.equal(resolvedHarnessCanonicalJson(resolved), resolvedHarnessCanonicalJson(again));
  });

  it("resolves inline + file connectors for the reference harness", () => {
    const resolved = resolveHarness(example);
    assert.equal(resolved.resolution.connectors.length, 2);
    assert.deepEqual(resolved.resolution.selected, ["sensor.temperature.read", "system.wait"]);
    const toolIds = resolved.agent.tools.map((t) => t.id).sort();
    assert.deepEqual(toolIds, [
      "sensor.fan.read_percent",
      "sensor.temperature.read",
      "system.wait",
    ]);
    assert.equal(resolved.resolution.lock.length, 2);
    for (const entry of resolved.resolution.lock) {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }
    const fileLock = resolved.resolution.lock.find((l) => l.kind === "file");
    assert.ok(fileLock);
    assert.equal(fileLock!.path, "connectors/wait.yml");
    const text = readFileSync(join(example, "connectors/wait.yml"), "utf8");
    assert.equal(fileLock!.sha256, sha256(text));
  });

  it("is byte-stable across repeated resolves", () => {
    const a = resolvedHarnessCanonicalJson(resolveHarness(example));
    const b = resolvedHarnessCanonicalJson(resolveHarness(example));
    assert.equal(a, b);
    assert.equal(resolvedHarnessHash(resolveHarness(example)).length, 64);
  });

  it("enforces file sha256 pins", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-conn-hash-"));
    try {
      writeFileSync(
        join(dir, "agent.yml"),
        `spec: counterbalance-contract/v0.1\nname: t\nstate: {}\ntools:\n  - id: ping.local\n`,
        "utf8",
      );
      mkdirSync(join(dir, "connectors"));
      writeFileSync(
        join(dir, "connectors/echo.yml"),
        `format: fausth-connector-manifest/v0.1\nprovides:\n  - id: echo.ping\n`,
        "utf8",
      );
      writeFileSync(
        join(dir, "connectors.yml"),
        `format: fausth-connectors/v0.1\nconnectors:\n  - id: echo\n    kind: file\n    path: connectors/echo.yml\n    sha256: "${"0".repeat(64)}"\n`,
        "utf8",
      );
      assert.throws(() => resolveHarness(dir), (e: unknown) => {
        assert.ok(e instanceof ConnectorError);
        assert.equal(e.code, "connectors_hash_mismatch");
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown select and path traversal", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-conn-bad-"));
    try {
      writeFileSync(
        join(dir, "agent.yml"),
        `spec: counterbalance-contract/v0.1\nname: t\nstate: {}\ntools:\n  - id: ping.local\n`,
        "utf8",
      );
      writeFileSync(
        join(dir, "connectors.yml"),
        `format: fausth-connectors/v0.1\nconnectors:\n  - id: greet\n    kind: inline\n    provides:\n      - id: greet.say\n    select: [missing.tool]\n`,
        "utf8",
      );
      assert.throws(() => resolveHarness(dir), (e: unknown) => {
        assert.ok(e instanceof ConnectorError);
        assert.equal(e.code, "connectors_unknown_select");
        return true;
      });

      writeFileSync(
        join(dir, "connectors.yml"),
        `format: fausth-connectors/v0.1\nconnectors:\n  - id: escape\n    kind: file\n    path: ../outside.yml\n`,
        "utf8",
      );
      assert.throws(() => resolveHarness(dir), (e: unknown) => {
        assert.ok(e instanceof ConnectorError);
        assert.equal(e.code, "connectors_path");
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects secret-like keys in connector manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-conn-secret-"));
    try {
      writeFileSync(
        join(dir, "agent.yml"),
        `spec: counterbalance-contract/v0.1\nname: t\nstate: {}\ntools:\n  - id: ping.local\n`,
        "utf8",
      );
      writeFileSync(
        join(dir, "connectors.yml"),
        `format: fausth-connectors/v0.1\nconnectors:\n  - id: greet\n    kind: inline\n    api_key: secret\n    provides:\n      - id: greet.say\n`,
        "utf8",
      );
      assert.throws(() => resolveHarness(dir), (e: unknown) => {
        assert.ok(e instanceof ConnectorError);
        assert.equal(e.code, "connectors_secret");
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inspect reports resolution metadata", () => {
    const report = inspectHarness(example);
    assert.equal(report.resolution?.ok, true);
    assert.equal(report.resolution?.connectors_file, true);
    assert.equal(report.resolution?.connector_count, 2);
    assert.deepEqual(report.resolution?.kinds, ["file", "inline"]);
    assert.equal(report.resolution?.selected_count, 2);
    assert.match(report.resolution?.resolved_sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok(report.tools.includes("sensor.temperature.read"));
    assert.ok(report.tools.includes("system.wait"));
    assert.equal(report.binding_coverage?.ok, true);

    const legacy = inspectHarness(coding);
    assert.equal(legacy.resolution?.ok, true);
    assert.equal(legacy.resolution?.connectors_file, false);
    assert.equal(legacy.resolution?.connector_count, 0);
  });

  it("test executes connector-provided tools through resolved bindings", async () => {
    const result = await testHarness(example, { skipFixtures: true });
    assert.equal(result.validate_ok, true);
    assert.equal(result.bindings_ok, true);
    assert.equal(result.smoke_ok, true);
    assert.equal(result.ok, true);
  });

  it("missing connector binding fails before smoke execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-conn-binding-"));
    try {
      for (const name of ["agent.yml", "connectors.yml", "smoke.model.jsonl"]) {
        writeFileSync(join(dir, name), readFileSync(join(example, name), "utf8"), "utf8");
      }
      mkdirSync(join(dir, "connectors"));
      writeFileSync(
        join(dir, "connectors/wait.yml"),
        readFileSync(join(example, "connectors/wait.yml"), "utf8"),
        "utf8",
      );
      writeFileSync(
        join(dir, "deployment.fixture.yml"),
        `platform: fixture
model:
  transport: recorded
bindings:
  sensor.fan.read_percent:
    native: stub.fan_read
  sensor.temperature.read:
    native: stub.temperature
`,
        "utf8",
      );
      const result = await testHarness(dir, { skipFixtures: true });
      assert.equal(result.bindings_ok, false);
      assert.equal(result.smoke_ok, null);
      assert.match(result.errors.join("\n"), /system\.wait.*binding_missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves mcp descriptors and module manifests", async () => {
    const mcpExample = join(root, "examples/primitives/mcp-connectors");
    const resolved = resolveHarness(mcpExample);
    assert.equal(resolved.resolution.connectors.length, 1);
    assert.equal(resolved.resolution.connectors[0]!.kind, "mcp");
    assert.deepEqual(resolved.resolution.selected, ["get_forecast"]);
    assert.ok(resolved.agent.tools.some((t) => t.id === "get_forecast"));
    assert.equal(
      resolved.resolution.connectors[0]!.mcp_tools?.get_forecast,
      "get_forecast",
    );

    const dir = mkdtempSync(join(tmpdir(), "fausth-module-"));
    try {
      writeFileSync(
        join(dir, "agent.yml"),
        readFileSync(join(mcpExample, "agent.yml"), "utf8"),
        "utf8",
      );
      mkdirSync(join(dir, "connectors/module"), { recursive: true });
      writeFileSync(
        join(dir, "connectors/module/echo.json"),
        JSON.stringify({
          format: "fausth-module-manifest/v0.1",
          provides: [
            {
              id: "echo.ping",
              input: { type: "object", additionalProperties: false, properties: {} },
              output: {
                type: "object",
                required: ["ok"],
                additionalProperties: false,
                properties: { ok: { type: "integer" } },
              },
            },
          ],
        }),
        "utf8",
      );
      writeFileSync(
        join(dir, "connectors.yml"),
        `format: fausth-connectors/v0.1
connectors:
  - id: plugin
    kind: module
    path: connectors/module/echo.json
    select: [echo.ping]
`,
        "utf8",
      );
      const mod = resolveHarness(dir);
      assert.equal(mod.resolution.connectors[0]!.kind, "module");
      assert.deepEqual(mod.resolution.selected, ["echo.ping"]);

      // Wrong sha256 pin fails closed (deny-unsigned / pin enforcement)
      writeFileSync(
        join(dir, "connectors.yml"),
        `format: fausth-connectors/v0.1
connectors:
  - id: plugin
    kind: module
    path: connectors/module/echo.json
    sha256: "${"0".repeat(64)}"
    select: [echo.ping]
`,
        "utf8",
      );
      assert.throws(() => resolveHarness(dir), (e: unknown) => {
        return e instanceof ConnectorError && e.code === "connectors_hash_mismatch";
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const result = await testHarness(mcpExample, { skipFixtures: true });
    assert.equal(result.ok, true);
    assert.equal(result.smoke_ok, true);
  });
});
