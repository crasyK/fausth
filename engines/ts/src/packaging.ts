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
import { AdapterError, bindToolsFromDeployment } from "./adapters/registry.js";
import { FaustRuntime, eventsToJsonl } from "./runtime.js";
import { parseRecordedModelLine } from "./adapters/recorded.js";
import { createGreenhouseTools, createCodingTools, createSpawnTool, codingWorldFromAgent } from "./tools/world.js";
import type {
  AgentIR,
  Deployment,
  Event,
  HarnessPatch,
  ModelProposal,
  RecordedToolCall,
} from "./types.js";
import { canonicalJson } from "./canonical.js";
import {
  ConnectorError,
  decodeUtf8Strict,
  resolveHarness,
  resolvedHarnessHash,
} from "./connectors/resolve.js";
import { signBundle, loadSignKeyFromPath } from "./bundle-signature.js";
import { applyCandidatePatch, harnessIrHash } from "./harness-patch.js";
import {
  assertLoadableBundle,
  BUNDLE_FORMAT_V01,
  BUNDLE_FORMAT_V02,
  BUNDLE_FORMAT_V03,
  BundleError,
} from "./bundle.js";

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
      bindToolsFromDeployment(agent, dep, {
        harnessDir: dir,
        resolved: resolvedIr,
        deploymentPath: depPath,
      }).cleanup();
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
  const files: Record<string, string> = {
    "src/app.ts": "export {}",
    "src/app.js": 'export function greet(){ return "hello"; }\n',
  };
  const secrets = agent.permissions?.secrets;
  if (secrets?.paths) {
    for (const p of secrets.paths) {
      if (files[p] === undefined) files[p] = "sk-fixture-secret-0001";
    }
  }
  for (const p of agent.permissions?.protected_paths ?? []) {
    if (files[p] === undefined) {
      files[p] = 'export function greet(){ return "hello"; }\n';
    }
  }
  return {
    ...createGreenhouseTools({
      temperature_decidegrees: Number(agent.state.temperature_decidegrees ?? 250),
      fan_percent: Number(agent.state.fan_percent ?? 0),
      sensor_healthy: Number(agent.state.sensor_healthy ?? 1),
    }),
    ...createCodingTools(codingWorldFromAgent(agent, { files })),
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
  resolved: import("./types.js").ResolvedHarnessIR | undefined,
  deploymentPath: string,
): Promise<{ ok: boolean; detail: string }> {
  const modelPath = join(harnessDir, "smoke.model.jsonl");
  const expectedPath = join(harnessDir, "smoke.expected.jsonl");
  if (!existsSync(modelPath)) {
    return { ok: true, detail: "no smoke.model.jsonl (skipped)" };
  }
  const { tools, cleanup } = bindToolsFromDeployment(agent, deployment, {
    harnessDir,
    resolved,
    deploymentPath,
  });
  let actual: string;
  try {
    const proposals: ModelProposal[] = readJsonl(modelPath).map(parseRecordedModelLine);
    let pi = 0;
    const rt = new FaustRuntime({
      agent,
      propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
      tools,
    });
    await rt.runLoop(32);
    actual = eventsToJsonl(rt.events);
  } finally {
    cleanup();
  }
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
    bindToolsFromDeployment(agent, deployment, {
      harnessDir: dir,
      resolved,
      deploymentPath: depPath,
    }).cleanup();
    details.push(`bindings OK (${basename(depPath)})`);
  } catch (e) {
    bindings_ok = false;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  let smoke_ok: boolean | null = null;
  if (bindings_ok) {
    try {
      const smoke = await runSmoke(agent, deployment, dir, resolved, depPath);
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

/** Recorded host fixtures that only the v0.3 allowlist admits. */
const V03_RECORDED_EXTRAS = ["mcp.recorded.jsonl", "module.recorded.jsonl"];

/** Raw bytes → strict UTF-8 text (CRLF and BOM preserved exactly; invalid UTF-8 refused). */
function readPackText(abs: string, rel: string): string {
  const text = decodeUtf8Strict(readFileSync(abs));
  if (text === null) {
    throw new BundleError("bundle_invalid", `pack: file is not valid UTF-8: ${rel}`);
  }
  return text;
}

function collectPackSourceFiles(dir: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const n of PACK_INCLUDE) {
    const p = join(dir, n);
    if (existsSync(p) && statSync(p).isFile()) {
      files.push({ path: n, content: readPackText(p, n) });
      seen.add(n);
    }
  }
  for (const ent of readdirSync(dir).sort()) {
    if (/^deployment\..+\.ya?ml$/i.test(ent) && !seen.has(ent)) {
      files.push({ path: ent, content: readPackText(join(dir, ent), ent) });
    }
  }
  return files;
}

function sortByPath(files: { path: string; content: string }[]): void {
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Pack harness into a portable `.fausth.json` bundle (git/archives before registry).
 * Manifest-less harnesses → byte-identical v0.1.
 * Connector harnesses without mcp/module → v0.2.
 * MCP or module connector harnesses → v0.3 (+ optional top-level recorded fixtures).
 * The packed object is run through the loader's own validation before it is written, so
 * pack can never emit a bundle that load/verify rejects.
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

  let bundle: Record<string, unknown>;
  if (hasConnectors) {
    const resolved = resolveHarness(dir);
    const v03 = resolved.resolution.lock.some((l) => l.kind === "mcp" || l.kind === "module");
    for (const n of CONNECTOR_MANIFEST_NAMES) {
      const p = join(dir, n);
      if (existsSync(p) && statSync(p).isFile()) {
        files.push({ path: n, content: readPackText(p, n) });
      }
    }
    for (const lock of resolved.resolution.lock) {
      if ((lock.kind !== "file" && lock.kind !== "mcp" && lock.kind !== "module") || !lock.path) continue;
      const p = join(dir, lock.path);
      if (!existsSync(p) || !statSync(p).isFile()) {
        throw new ConnectorError(
          "connectors_path",
          `pack: lock path missing on disk: ${lock.path}`,
        );
      }
      if (!files.some((f) => f.path === lock.path)) {
        files.push({ path: lock.path, content: readPackText(p, lock.path) });
      }
    }
    if (v03) {
      // Recorded host fixtures for Track A packs — only v0.3 admits them.
      for (const extra of V03_RECORDED_EXTRAS) {
        const p = join(dir, extra);
        if (existsSync(p) && statSync(p).isFile() && !files.some((f) => f.path === extra)) {
          files.push({ path: extra, content: readPackText(p, extra) });
        }
      }
    }
    sortByPath(files);
    bundle = {
      format: v03 ? BUNDLE_FORMAT_V03 : BUNDLE_FORMAT_V02,
      name,
      files: Object.fromEntries(files.map((f) => [f.path, f.content])),
      resolved,
      resolved_sha256: resolvedHarnessHash(resolved),
    };
  } else {
    sortByPath(files);
    bundle = {
      format: BUNDLE_FORMAT_V01,
      name,
      files: Object.fromEntries(files.map((f) => [f.path, f.content])),
    };
  }

  // Same rules as load/verify (entry allowlist, limits, lock pins, re-resolution).
  assertLoadableBundle(bundle);

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

// ---------------------------------------------------------------------------
// Selection gate (M16): "self-learning without gates is mutation without selection".
// ---------------------------------------------------------------------------

/** Governed outcome of one run on a recorded transcript. */
export type TranscriptOutcome = {
  /** Set when the run could not follow the recorded transcript (or threw). */
  error?: string;
  /** Completion tool executed AND all its verifies passed (D8); null if no completion declared. */
  completed: boolean | null;
  /** Multiset of deny / safe_state verdicts keyed `verdict|stage|tool|reason`. */
  denies: Record<string, number>;
};

export type FixtureFitness = {
  fixture: string;
  /** The fixture's own agent still reproduces its golden log (corpus health; informational). */
  golden_ok: boolean;
  /** Baseline (unpatched harness) replayed the transcript without error. */
  replayable: boolean;
  baseline: TranscriptOutcome;
  candidate: TranscriptOutcome;
  /** null when the transcript is not replayable on this harness (excluded from fitness). */
  candidate_pass: boolean | null;
  reasons: string[];
};

export type SelectResult = {
  ok: boolean;
  harness_hash_before: string;
  harness_hash_after: string;
  /** True when no evaluated fixture regressed (also true when fitness was skipped). */
  fixtures_ok: boolean;
  /** Candidate changes nothing outside the declared mutable cells. */
  security_ok: boolean;
  security_changes: string[];
  /** False when fixtures were skipped or none matched: the candidate is NOT fitness-tested. */
  fitness_evaluated: boolean;
  fitness: {
    fixtures: number;
    replayable: number;
    candidate_passed: number;
    candidate_failed: number;
  };
  fixtures: FixtureFitness[];
  details: string[];
  errors: string[];
  patched_agent?: AgentIR;
};

/** Surfaces a skills/memory/instincts patch may change; everything else is a security cell. */
function securityProjection(agent: AgentIR): Record<string, unknown> {
  const clone = structuredClone(agent) as AgentIR & Record<string, unknown>;
  clone.tools = clone.tools.map((t) => {
    const { description: _d, ...rest } = t;
    return rest;
  });
  if (clone.counterbalance) {
    const { memory_notes: _m, ...rest } = clone.counterbalance as Record<string, unknown>;
    clone.counterbalance = rest as AgentIR["counterbalance"];
  }
  delete clone.instinct_text;
  return clone as Record<string, unknown>;
}

/**
 * Independent of harness-patch's op validation: compare IR before/after and refuse any
 * change outside the declared mutable cells (permissions, scopes, protected paths, secrets,
 * gates, limits, spawn, checkpoints, sequences, tool contracts, state, …).
 */
export function securityCellChanges(before: AgentIR, after: AgentIR): string[] {
  const changes: string[] = [];
  const a = securityProjection(before);
  const b = securityProjection(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    if (canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null)) changes.push(`security cell changed: ${k}`);
  }
  const mutable = new Set(before.mutable ?? []);
  const descBefore = canonicalJson(before.tools.map((t) => [t.id, t.description ?? null]));
  const descAfter = canonicalJson(after.tools.map((t) => [t.id, t.description ?? null]));
  if (descBefore !== descAfter && !mutable.has("skills")) {
    changes.push("cell not mutable: skills (tool descriptions changed)");
  }
  const notesBefore = canonicalJson(before.counterbalance?.memory_notes ?? null);
  const notesAfter = canonicalJson(after.counterbalance?.memory_notes ?? null);
  if (notesBefore !== notesAfter && !mutable.has("memory")) {
    changes.push("cell not mutable: memory (memory_notes changed)");
  }
  if ((before.instinct_text ?? null) !== (after.instinct_text ?? null) && !mutable.has("instincts")) {
    changes.push("cell not mutable: instincts (instinct_text changed)");
  }
  return changes;
}

const TRANSCRIPT_MISMATCH = "Recorded transcript mismatch";

/** Summarise the governed outcome of an event log. */
export function transcriptOutcome(agent: AgentIR, events: Event[]): TranscriptOutcome {
  const denies: Record<string, number> = {};
  let error: string | undefined;
  const completionTool = agent.counterbalance?.completion?.tool;
  let completed: boolean | null = completionTool ? false : null;
  let pendingTool: string | undefined;
  let pendingOk = false;
  const settle = () => {
    if (pendingTool && pendingOk && completionTool && pendingTool === completionTool) completed = true;
    pendingTool = undefined;
    pendingOk = false;
  };
  for (const e of events) {
    if (e.stage === "propose" || e.stage === "orient") settle();
    if (e.verdict === "deny" || e.verdict === "safe_state") {
      const key = `${e.verdict}|${e.stage}|${e.tool ?? ""}|${e.reason ?? ""}`;
      denies[key] = (denies[key] ?? 0) + 1;
    }
    if (!error && typeof e.error === "string" && e.error.startsWith(TRANSCRIPT_MISMATCH)) {
      error = `recorded transcript diverged at seq ${e.seq}`;
    }
    if (e.stage === "execute") {
      settle();
      if (e.verdict === "allow" && e.tool) {
        pendingTool = e.tool;
        pendingOk = true;
      }
    } else if (e.stage === "verify" && pendingTool && e.verdict && e.verdict !== "allow") {
      pendingOk = false;
    }
  }
  settle();
  const sorted = Object.fromEntries(Object.keys(denies).sort().map((k) => [k, denies[k]!]));
  return { ...(error ? { error } : {}), completed, denies: sorted };
}

async function runAgentOnTranscript(
  agent: AgentIR,
  proposals: ModelProposal[],
  recorded: RecordedToolCall[],
): Promise<{ events: Event[]; error?: string }> {
  let pi = 0;
  const runtime = new FaustRuntime({
    agent,
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools: buildTools(agent),
    recordedToolResults: recorded.length ? structuredClone(recorded) : undefined,
    allowJudge: false,
  });
  try {
    await runtime.runLoop();
    return { events: runtime.events };
  } catch (e) {
    return { events: runtime.events, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Candidate fitness on one fixture transcript vs the unpatched baseline. */
export async function evaluateFixtureFitness(
  fixtureDir: string,
  baselineAgent: AgentIR,
  candidateAgent: AgentIR,
): Promise<FixtureFitness> {
  const name = basename(fixtureDir);
  const golden = await replayFixtureDir(fixtureDir);
  const proposals: ModelProposal[] = readJsonl(join(fixtureDir, "model.jsonl")).map(parseRecordedModelLine);
  const recorded = existsSync(join(fixtureDir, "tools.jsonl"))
    ? (readJsonl(join(fixtureDir, "tools.jsonl")) as RecordedToolCall[])
    : [];
  const baseRun = await runAgentOnTranscript(baselineAgent, proposals, recorded);
  const candRun = await runAgentOnTranscript(candidateAgent, proposals, recorded);
  const baseline = transcriptOutcome(baselineAgent, baseRun.events);
  if (baseRun.error) baseline.error = baseRun.error;
  const candidate = transcriptOutcome(candidateAgent, candRun.events);
  if (candRun.error) candidate.error = candRun.error;
  const replayable = baseline.error === undefined;
  const reasons: string[] = [];
  if (replayable) {
    if (candidate.error) reasons.push(`candidate did not replay: ${candidate.error}`);
    for (const [key, n] of Object.entries(baseline.denies)) {
      const got = candidate.denies[key] ?? 0;
      if (got < n) reasons.push(`lost ${n - got}× ${key}`);
    }
    if (baseline.completed === true && candidate.completed !== true) {
      reasons.push("lost completion");
    }
  }
  return {
    fixture: name,
    golden_ok: golden.ok,
    replayable,
    baseline,
    candidate,
    candidate_pass: replayable ? reasons.length === 0 : null,
    reasons,
  };
}

/**
 * Selection gate: apply a candidate patch, refuse any change outside the mutable cells,
 * then run BOTH the unpatched harness (baseline) and the patched harness (candidate) on each
 * matching fixture's recorded model transcript. The candidate is selected only if it loses
 * no deny / safe_state and no completion that the baseline had on any replayable fixture.
 * Recorded transcripts cannot show a live-behaviour improvement — this is a regression and
 * security gate, not a fitness maximiser. Reproduction is `fausth pack` of the patched harness.
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
  const emptyFitness = { fixtures: 0, replayable: 0, candidate_passed: 0, candidate_failed: 0 };

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
      security_ok: false,
      security_changes: [],
      fitness_evaluated: false,
      fitness: emptyFitness,
      fixtures: [],
      details,
      errors: [msg],
    };
  }
  const after = harnessIrHash(patched);
  details.push(`patch applied ${before.slice(0, 12)}… → ${after.slice(0, 12)}…`);

  const securityChanges = securityCellChanges(agent, patched);
  const securityOk = securityChanges.length === 0;
  if (!securityOk) {
    errors.push(...securityChanges.map((c) => `candidate rejected: ${c}`));
    return {
      ok: false,
      harness_hash_before: before,
      harness_hash_after: after,
      fixtures_ok: false,
      security_ok: false,
      security_changes: securityChanges,
      fitness_evaluated: false,
      fitness: emptyFitness,
      fixtures: [],
      details,
      errors,
    };
  }
  details.push("security cells unchanged");

  if (opts.skipFixtures) {
    return {
      ok: true,
      harness_hash_before: before,
      harness_hash_after: after,
      fixtures_ok: true,
      security_ok: true,
      security_changes: [],
      fitness_evaluated: false,
      fitness: emptyFitness,
      fixtures: [],
      details: [...details, "fixtures skipped — candidate NOT fitness-tested"],
      errors,
      patched_agent: patched,
    };
  }

  const fixturesRoot =
    opts.fixturesRoot ?? join(dir, "../../conformance/fixtures");
  let prefixes = fixturePrefixesForHarness(basename(dir));
  if (!prefixes.length && agent.mutable?.length) prefixes = ["cb-harness-patch-"];

  const fixtures: FixtureFitness[] = [];
  if (!prefixes.length) {
    details.push("no fixture prefixes — candidate NOT fitness-tested");
  } else if (!existsSync(fixturesRoot)) {
    errors.push(`fixtures root missing: ${fixturesRoot}`);
  } else {
    const dirs = listFixtureDirs(fixturesRoot).filter((d) =>
      prefixes.some((p) => basename(d).startsWith(p)),
    );
    for (const fd of dirs) {
      const f = await evaluateFixtureFitness(fd, agent, patched);
      fixtures.push(f);
      const golden = f.golden_ok ? "" : " (fixture golden stale)";
      if (f.candidate_pass === null) {
        details.push(`${f.fixture}: not replayable on this harness (${f.baseline.error ?? "?"})${golden}`);
      } else if (f.candidate_pass) {
        details.push(`${f.fixture}: candidate PASS${golden}`);
      } else {
        details.push(`${f.fixture}: candidate FAIL${golden}`);
        errors.push(`${f.fixture}: candidate regressed — ${f.reasons.join("; ")}`);
      }
    }
  }
  const fitness = {
    fixtures: fixtures.length,
    replayable: fixtures.filter((f) => f.replayable).length,
    candidate_passed: fixtures.filter((f) => f.candidate_pass === true).length,
    candidate_failed: fixtures.filter((f) => f.candidate_pass === false).length,
  };
  if (prefixes.length && fitness.replayable === 0 && errors.length === 0) {
    details.push("no replayable fixture transcripts — candidate NOT fitness-tested");
  }
  const fixturesOk = fitness.candidate_failed === 0 && errors.length === 0;

  return {
    ok: fixturesOk,
    harness_hash_before: before,
    harness_hash_after: after,
    fixtures_ok: fixturesOk,
    security_ok: true,
    security_changes: [],
    fitness_evaluated: fitness.replayable > 0,
    fitness,
    fixtures,
    details,
    errors,
    patched_agent: patched,
  };
}
