/**
 * Harness packaging surface (M7): inspect / test / pack helpers.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  loadAgentDir,
  loadDeployment,
  listFixtureDirs,
  readJsonl,
} from "./load.js";
import { validateAgent } from "./validate.js";
import { AdapterError, resolveToolsFromDeployment } from "./adapters/registry.js";
import { FaustRuntime, eventsToJsonl } from "./runtime.js";
import { parseRecordedModelLine } from "./adapters/recorded.js";
import { createGreenhouseTools, createCodingTools, createSpawnTool, codingWorldFromAgent } from "./tools/world.js";
import type { AgentIR, Deployment, HarnessPatch, ModelProposal, RecordedToolCall } from "./types.js";
import { canonicalJson } from "./canonical.js";
import {
  ConnectorError,
  resolveHarness,
  resolvedHarnessHash,
} from "./connectors/resolve.js";
import { signBundle, loadSignKeyFromPath } from "./bundle-signature.js";
import { applyCandidatePatch, harnessIrHash } from "./harness-patch.js";

// load.ts may not export loadFixtureAgent — inline
function loadFixtureAgentLocal(dir: string): AgentIR {
  const json = join(dir, "agent.json");
  if (existsSync(json)) return JSON.parse(readFileSync(json, "utf8")) as AgentIR;
  return loadAgentDir(dir).agent;
}

const DEPLOYMENT_CANDIDATES = [
  "deployment.fixture.yml",
  "deployment.simulation.yml",
  "deployment.openrouter-free.yml",
  "deployment.kit.yml",
  "deployment.openai.yml",
  "deployment.ollama.yml",
];

/** Local real-I/O deployments — never auto-selected by test/replay/default discovery. */
const LOCAL_DEPLOYMENT_PREFIX = "deployment.local";

export function isLocalOnlyDeploymentFile(name: string): boolean {
  return name.startsWith(LOCAL_DEPLOYMENT_PREFIX);
}

export function listHarnessDeployments(harnessDir: string): string[] {
  return DEPLOYMENT_CANDIDATES.filter((n) => existsSync(join(harnessDir, n))).map((n) =>
    join(harnessDir, n),
  );
}

export function pickTestDeployment(harnessDir: string, explicit?: string): string | undefined {
  if (explicit) return resolve(explicit);
  for (const n of ["deployment.fixture.yml", "deployment.simulation.yml"]) {
    const p = join(harnessDir, n);
    if (existsSync(p)) return p;
  }
  return listHarnessDeployments(harnessDir).find((p) => {
    const base = p.split(/[/\\]/).pop() ?? "";
    return !isLocalOnlyDeploymentFile(base);
  });
}

export type InspectReport = {
  harness: string;
  path: string;
  name: string;
  spec: string;
  tools: string[];
  permissions_tools?: string[];
  sequences?: string[];
  mutable?: string[];
  spawn?: AgentIR["spawn"];
  deployments: { file: string; platform?: string; transport?: string; binding_count: number }[];
  smoke: { model: boolean; expected: boolean };
  binding_coverage?: {
    deployment: string;
    missing: string[];
    ok: boolean;
    error?: string;
  };
  resolution?: {
    connectors_file: boolean;
    connector_count: number;
    kinds: string[];
    selected_count: number;
    lock_count: number;
    resolved_sha256: string;
    ok: boolean;
    error?: string;
    bundle_format?: string;
    embedded?: boolean;
  };
};

export function inspectHarness(
  harnessDir: string,
  opts: {
    embeddedResolved?: import("./types.js").ResolvedHarnessIR;
    bundleFormat?: string;
  } = {},
): InspectReport {
  const dir = resolve(harnessDir);
  const { agent: sourceAgent } = loadAgentDir(dir);
  const connectorsPresent =
    existsSync(join(dir, "connectors.yml")) ||
    existsSync(join(dir, "connectors.yaml")) ||
    existsSync(join(dir, "connectors.json"));
  let agent = sourceAgent;
  let resolution: InspectReport["resolution"];
  let resolvedIr: import("./types.js").ResolvedHarnessIR | undefined;
  try {
    resolvedIr = opts.embeddedResolved ?? resolveHarness(dir);
    agent = resolvedIr.agent;
    resolution = {
      connectors_file: connectorsPresent || Boolean(opts.embeddedResolved),
      connector_count: resolvedIr.resolution.connectors.length,
      kinds: Array.from(
        new Set(resolvedIr.resolution.connectors.map((c) => c.kind)),
      ).sort(),
      selected_count: resolvedIr.resolution.selected.length,
      lock_count: resolvedIr.resolution.lock.length,
      resolved_sha256: resolvedHarnessHash(resolvedIr),
      ok: true,
      ...(opts.bundleFormat ? { bundle_format: opts.bundleFormat } : {}),
      ...(opts.embeddedResolved ? { embedded: true } : {}),
    };
  } catch (e) {
    resolution = {
      connectors_file: connectorsPresent,
      connector_count: 0,
      kinds: [],
      selected_count: 0,
      lock_count: 0,
      resolved_sha256: "",
      ok: false,
      error: e instanceof ConnectorError || e instanceof Error ? e.message : String(e),
      ...(opts.bundleFormat ? { bundle_format: opts.bundleFormat } : {}),
    };
  }
  const auto = listHarnessDeployments(dir);
  const localExtras = readdirSync(dir)
    .filter((n) => isLocalOnlyDeploymentFile(n) && /\.ya?ml$/i.test(n))
    .map((n) => join(dir, n));
  const deployments = [...auto, ...localExtras].map((p) => {
    const d = loadDeployment(p) as Deployment;
    return {
      file: basename(p),
      platform: d.platform,
      transport: d.model?.transport,
      binding_count: Object.keys(d.bindings ?? {}).length,
    };
  });

  const report: InspectReport = {
    harness: basename(dir),
    path: dir,
    name: agent.name,
    spec: agent.spec,
    tools: agent.tools.map((t) => t.id),
    permissions_tools: agent.permissions?.tools,
    sequences: agent.counterbalance?.sequences?.map((s) => s.id ?? s.action),
    mutable: agent.mutable,
    spawn: agent.spawn,
    deployments,
    smoke: {
      model: existsSync(join(dir, "smoke.model.jsonl")),
      expected: existsSync(join(dir, "smoke.expected.jsonl")),
    },
    resolution,
  };

  const depPath = pickTestDeployment(dir);
  if (depPath) {
    try {
      const dep = loadDeployment(depPath) as Deployment;
      resolveToolsFromDeployment(agent, dep, {
        harnessDir: dir,
        resolved: resolvedIr,
      });
      report.binding_coverage = {
        deployment: basename(depPath),
        missing: [],
        ok: true,
      };
    } catch (e) {
      const missing: string[] = [];
      if (e instanceof AdapterError && e.code === "binding_missing") {
        const m = /tool '([^']+)'/.exec(e.message);
        if (m) missing.push(m[1]!);
      }
      report.binding_coverage = {
        deployment: basename(depPath),
        missing,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return report;
}

function buildTools(agent: AgentIR) {
  return {
    ...createGreenhouseTools({
      temperature_decidegrees: Number(agent.state.temperature_decidegrees ?? 250),
      fan_percent: Number(agent.state.fan_percent ?? 0),
      sensor_healthy: Number(agent.state.sensor_healthy ?? 1),
    }),
    ...createCodingTools(codingWorldFromAgent(agent)),
    ...createSpawnTool(agent.permissions?.tools ?? []),
  };
}

async function replayFixtureDir(
  dir: string,
): Promise<{ ok: boolean; name: string }> {
  const name = basename(dir);
  const agent = loadFixtureAgentLocal(dir);
  const proposals: ModelProposal[] = readJsonl(join(dir, "model.jsonl")).map(parseRecordedModelLine);
  const toolsQueue = existsSync(join(dir, "tools.jsonl"))
    ? (readJsonl(join(dir, "tools.jsonl")) as RecordedToolCall[])
    : [];
  let pi = 0;
  const runtime = new FaustRuntime({
    agent,
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools: buildTools(agent),
    recordedToolResults: toolsQueue.length ? toolsQueue : undefined,
    allowJudge: false,
  });
  await runtime.runLoop();
  const actual = eventsToJsonl(runtime.events);
  const expected = readFileSync(join(dir, "expected.jsonl"), "utf8").replace(/\r\n/g, "\n");
  return { ok: actual === expected, name };
}

export type TestHarnessResult = {
  ok: boolean;
  validate_ok: boolean;
  bindings_ok: boolean;
  smoke_ok: boolean | null;
  fixtures_ok: boolean | null;
  errors: string[];
  details: string[];
};

async function runSmoke(
  agent: AgentIR,
  deployment: Deployment,
  harnessDir: string,
  resolved?: import("./types.js").ResolvedHarnessIR,
): Promise<{ ok: boolean; detail: string }> {
  const modelPath = join(harnessDir, "smoke.model.jsonl");
  const expectedPath = join(harnessDir, "smoke.expected.jsonl");
  if (!existsSync(modelPath)) {
    return { ok: true, detail: "no smoke.model.jsonl (skipped)" };
  }
  const tools = resolveToolsFromDeployment(agent, deployment, {
    harnessDir,
    resolved,
  });
  const proposals: ModelProposal[] = readJsonl(modelPath).map(parseRecordedModelLine);
  let pi = 0;
  const rt = new FaustRuntime({
    agent,
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools,
  });
  await rt.runLoop(32);
  const actual = eventsToJsonl(rt.events);
  if (!existsSync(expectedPath)) {
    return { ok: false, detail: "smoke.model.jsonl present but smoke.expected.jsonl missing" };
  }
  const expected = readFileSync(expectedPath, "utf8").replace(/\r\n/g, "\n");
  if (actual !== expected) {
    return { ok: false, detail: "smoke event log ≠ smoke.expected.jsonl" };
  }
  return { ok: true, detail: "smoke OK" };
}

function fixturePrefixesForHarness(harnessName: string): string[] {
  if (harnessName === "coding-counterbalance") {
    return ["cb-coding-", "cb-write-", "cb-stale-", "cb-completion-", "cb-user-", "cb-harness-patch-"];
  }
  if (harnessName === "mutable-skills") return ["cb-harness-patch-"];
  if (harnessName === "support-bot") return ["cb-support-"];
  if (harnessName === "coding") return ["code-", "spawn-"];
  if (harnessName === "greenhouse") {
    return ["allow-", "deny-", "verify-", "budget-", "predicate-", "input-"];
  }
  return [];
}

export async function testHarness(
  harnessDir: string,
  opts: {
    deployment?: string;
    fixturesRoot?: string;
    skipFixtures?: boolean;
    embeddedResolved?: import("./types.js").ResolvedHarnessIR;
    bundleFormat?: string;
  } = {},
): Promise<TestHarnessResult> {
  const dir = resolve(harnessDir);
  const errors: string[] = [];
  const details: string[] = [];

  let resolved;
  try {
    resolved = opts.embeddedResolved ?? resolveHarness(dir);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      validate_ok: false,
      bindings_ok: false,
      smoke_ok: null,
      fixtures_ok: null,
      errors: [message],
      details: [],
    };
  }
  if (opts.bundleFormat) details.push(`bundle ${opts.bundleFormat}`);
  if (opts.embeddedResolved) {
    details.push(
      `embedded resolved OK (sha256=${resolvedHarnessHash(resolved)}, ${resolved.resolution.connectors.length} connectors)`,
    );
  } else {
    details.push(`resolve OK (${resolved.resolution.connectors.length} connectors)`);
  }
  const v = validateAgent(resolved.agent);
  const validate_ok = v.ok;
  if (!v.ok) {
    errors.push(...v.errors);
    return {
      ok: false,
      validate_ok: false,
      bindings_ok: false,
      smoke_ok: null,
      fixtures_ok: null,
      errors,
      details,
    };
  }
  details.push("validate OK");
  for (const w of v.warnings) details.push(`warn: ${w}`);

  const agent = resolved.agent;
  const depPath = pickTestDeployment(dir, opts.deployment);
  if (!depPath) {
    errors.push("no deployment found for harness test (need fixture/simulation or --deployment)");
    return {
      ok: false,
      validate_ok,
      bindings_ok: false,
      smoke_ok: null,
      fixtures_ok: null,
      errors,
      details,
    };
  }
  const deployment = loadDeployment(depPath) as Deployment;
  let bindings_ok = true;
  try {
    resolveToolsFromDeployment(agent, deployment, {
      harnessDir: dir,
      resolved,
    });
    details.push(`bindings OK (${basename(depPath)})`);
  } catch (e) {
    bindings_ok = false;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  let smoke_ok: boolean | null = null;
  if (bindings_ok) {
    try {
      const smoke = await runSmoke(agent, deployment, dir, resolved);
      smoke_ok = smoke.ok;
      details.push(smoke.detail);
      if (!smoke.ok) errors.push(smoke.detail);
    } catch (e) {
      smoke_ok = false;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  let fixtures_ok: boolean | null = null;
  if (!opts.skipFixtures) {
    const prefixes = fixturePrefixesForHarness(basename(dir));
    const fixturesRoot =
      opts.fixturesRoot ??
      (existsSync(join(dir, "../../conformance/fixtures"))
        ? resolve(dir, "../../conformance/fixtures")
        : resolve(dir, "../../../conformance/fixtures"));
    if (prefixes.length && existsSync(fixturesRoot)) {
      const dirs = listFixtureDirs(fixturesRoot).filter((d) =>
        prefixes.some((p) => basename(d).startsWith(p)),
      );
      if (dirs.length) {
        fixtures_ok = true;
        for (const d of dirs) {
          const r = await replayFixtureDir(d);
          details.push(`${r.ok ? "PASS" : "FAIL"} fixture ${r.name}`);
          if (!r.ok) {
            fixtures_ok = false;
            errors.push(`fixture ${r.name} mismatch`);
          }
        }
      }
    }
  }

  const ok =
    validate_ok &&
    bindings_ok &&
    (smoke_ok === null || smoke_ok) &&
    (fixtures_ok === null || fixtures_ok);

  return { ok, validate_ok, bindings_ok, smoke_ok, fixtures_ok, errors, details };
}

const PACK_INCLUDE = [
  "agent.yml",
  "agent.json",
  "README.md",
  "smoke.model.jsonl",
  "smoke.expected.jsonl",
  ...DEPLOYMENT_CANDIDATES,
];

const CONNECTOR_MANIFEST_NAMES = ["connectors.yml", "connectors.yaml", "connectors.json"];

function collectPackSourceFiles(dir: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const n of PACK_INCLUDE) {
    const p = join(dir, n);
    if (existsSync(p) && statSync(p).isFile()) {
      files.push({ path: n, content: readFileSync(p, "utf8") });
      seen.add(n);
    }
  }
  for (const ent of readdirSync(dir).sort()) {
    if (/^deployment\..+\.ya?ml$/i.test(ent) && !seen.has(ent)) {
      files.push({ path: ent, content: readFileSync(join(dir, ent), "utf8") });
    }
  }
  return files;
}

/**
 * Pack harness into a portable `.fausth.json` bundle (git/archives before registry).
 * Manifest-less harnesses → byte-identical v0.1.
 * Connector harnesses without mcp → v0.2.
 * MCP connector harnesses → v0.3.
 * Optional Ed25519 signing via `signKey` path or FAUSTH_SIGN_KEY (opt-in; default unsigned).
 */
export function packHarness(
  harnessDir: string,
  outPath?: string,
  opts: { signKey?: string } = {},
): { out: string; files: string[]; format: string; signed: boolean } {
  const dir = resolve(harnessDir);
  const name = basename(dir);
  const hasConnectors = CONNECTOR_MANIFEST_NAMES.some(
    (n) => existsSync(join(dir, n)) && statSync(join(dir, n)).isFile(),
  );

  const files = collectPackSourceFiles(dir);
  // Optional MCP recorded fixture for Track A packs
  for (const extra of ["mcp.recorded.jsonl", "module.recorded.jsonl"]) {
    const p = join(dir, extra);
    if (existsSync(p) && statSync(p).isFile() && !files.some((f) => f.path === extra)) {
      files.push({ path: extra, content: readFileSync(p, "utf8") });
    }
  }

  let bundle: Record<string, unknown>;
  if (hasConnectors) {
    const resolved = resolveHarness(dir);
    const hasMcp = resolved.resolution.lock.some((l) => l.kind === "mcp");
    const hasModule = resolved.resolution.lock.some((l) => l.kind === "module");
    for (const n of CONNECTOR_MANIFEST_NAMES) {
      const p = join(dir, n);
      if (existsSync(p) && statSync(p).isFile()) {
        files.push({ path: n, content: readFileSync(p, "utf8") });
      }
    }
    for (const lock of resolved.resolution.lock) {
      if ((lock.kind !== "file" && lock.kind !== "mcp" && lock.kind !== "module") || !lock.path) continue;
      const p = join(dir, lock.path);
      if (!existsSync(p) || !statSync(p).isFile()) {
        throw new ConnectorError(
          "connector_import_not_found",
          `pack: lock path missing on disk: ${lock.path}`,
        );
      }
      if (!files.some((f) => f.path === lock.path)) {
        files.push({ path: lock.path, content: readFileSync(p, "utf8") });
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    bundle = {
      format: hasMcp || hasModule ? "fausth-harness-bundle/v0.3" : "fausth-harness-bundle/v0.2",
      name,
      files: Object.fromEntries(files.map((f) => [f.path, f.content])),
      resolved,
      resolved_sha256: resolvedHarnessHash(resolved),
    };
  } else {
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    bundle = {
      format: "fausth-harness-bundle/v0.1",
      name,
      files: Object.fromEntries(files.map((f) => [f.path, f.content])),
    };
  }

  const signKey = opts.signKey ?? process.env.FAUSTH_SIGN_KEY;
  let signed = false;
  if (signKey) {
    bundle = signBundle(bundle, loadSignKeyFromPath(signKey));
    signed = true;
  }

  let out: string;
  if (outPath && outPath.endsWith(".fausth.json")) {
    out = resolve(outPath);
    mkdirSync(join(out, ".."), { recursive: true });
  } else {
    const outDir = outPath ? resolve(outPath) : join(dir, "dist");
    mkdirSync(outDir, { recursive: true });
    out = join(outDir, `${name}.fausth.json`);
  }
  writeFileSync(out, canonicalJson(bundle) + "\n", "utf8");
  return {
    out,
    files: files.map((f) => f.path),
    format: String(bundle.format),
    signed,
  };
}

export type SelectResult = {
  ok: boolean;
  harness_hash_before: string;
  harness_hash_after: string;
  fixtures_ok: boolean;
  details: string[];
  errors: string[];
  patched_agent?: AgentIR;
};

/**
 * Selection gate: apply a candidate patch, then re-run matching Track A fixtures.
 * Any golden failure rejects the mutation. Reproduction is `fausth pack` of the patched harness.
 */
export async function selectHarness(
  harnessDir: string,
  patch: HarnessPatch,
  opts: { fixturesRoot?: string; skipFixtures?: boolean } = {},
): Promise<SelectResult> {
  const dir = resolve(harnessDir);
  const { agent } = loadAgentDir(dir);
  const before = harnessIrHash(agent);
  const details: string[] = [];
  const errors: string[] = [];

  let patched: AgentIR;
  try {
    patched = applyCandidatePatch(agent, patch);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      harness_hash_before: before,
      harness_hash_after: before,
      fixtures_ok: false,
      details,
      errors: [msg],
    };
  }
  const after = harnessIrHash(patched);
  details.push(`patch applied ${before.slice(0, 12)}… → ${after.slice(0, 12)}…`);

  if (opts.skipFixtures) {
    return {
      ok: true,
      harness_hash_before: before,
      harness_hash_after: after,
      fixtures_ok: true,
      details: [...details, "fixtures skipped"],
      errors,
      patched_agent: patched,
    };
  }

  const fixturesRoot =
    opts.fixturesRoot ?? join(dir, "../../conformance/fixtures");
  let prefixes = fixturePrefixesForHarness(basename(dir));
  if (!prefixes.length && agent.mutable?.length) prefixes = ["cb-harness-patch-"];

  let fixturesOk = true;
  if (!prefixes.length) {
    details.push("no fixture prefixes; selection accepted on patch validation alone");
  } else if (!existsSync(fixturesRoot)) {
    errors.push(`fixtures root missing: ${fixturesRoot}`);
    fixturesOk = false;
  } else {
    const dirs = listFixtureDirs(fixturesRoot).filter((d) =>
      prefixes.some((p) => basename(d).startsWith(p)),
    );
    for (const fd of dirs) {
      const r = await replayFixtureDir(fd);
      if (!r.ok) {
        fixturesOk = false;
        errors.push(`${r.name}: golden mismatch`);
      } else {
        details.push(`${r.name}: OK`);
      }
    }
  }

  return {
    ok: fixturesOk && errors.length === 0,
    harness_hash_before: before,
    harness_hash_after: after,
    fixtures_ok: fixturesOk,
    details,
    errors,
    patched_agent: patched,
  };
}

