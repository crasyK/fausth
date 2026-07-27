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
import { validateAgentPath } from "./validate.js";
import { AdapterError, resolveToolsFromDeployment } from "./adapters/registry.js";
import { FaustRuntime, eventsToJsonl } from "./runtime.js";
import { parseRecordedModelLine } from "./adapters/recorded.js";
import { createGreenhouseTools, createCodingTools, createSpawnTool } from "./tools/world.js";
import type { AgentIR, Deployment, ModelProposal, RecordedToolCall } from "./types.js";
import { canonicalJson } from "./canonical.js";

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
  modes?: string[];
  sequences?: string[];
  spawn?: AgentIR["spawn"];
  deployments: { file: string; platform?: string; transport?: string; binding_count: number }[];
  smoke: { model: boolean; expected: boolean };
  binding_coverage?: {
    deployment: string;
    missing: string[];
    ok: boolean;
    error?: string;
  };
};

export function inspectHarness(harnessDir: string): InspectReport {
  const dir = resolve(harnessDir);
  const { agent } = loadAgentDir(dir);
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
    modes: agent.counterbalance?.modes?.map((m) => m.id),
    sequences: agent.counterbalance?.sequences?.map((s) => s.id ?? s.action),
    spawn: agent.spawn,
    deployments,
    smoke: {
      model: existsSync(join(dir, "smoke.model.jsonl")),
      expected: existsSync(join(dir, "smoke.expected.jsonl")),
    },
  };

  const depPath = pickTestDeployment(dir);
  if (depPath) {
    try {
      const dep = loadDeployment(depPath) as Deployment;
      resolveToolsFromDeployment(agent, dep);
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
    ...createCodingTools({
      files: { "src/app.ts": "export {}" },
      write_scopes: agent.permissions?.filesystem?.write_scopes ?? ["src/"],
      last_exit_code: 1,
      out_of_scope_writes: 0,
    }),
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
): Promise<{ ok: boolean; detail: string }> {
  const modelPath = join(harnessDir, "smoke.model.jsonl");
  const expectedPath = join(harnessDir, "smoke.expected.jsonl");
  if (!existsSync(modelPath)) {
    return { ok: true, detail: "no smoke.model.jsonl (skipped)" };
  }
  const tools = resolveToolsFromDeployment(agent, deployment);
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
  if (harnessName === "coding-counterbalance") return ["cb-coding-", "cb-write-", "cb-stale-", "cb-completion-"];
  if (harnessName === "support-bot") return ["cb-support-"];
  if (harnessName === "coding") return ["code-", "spawn-"];
  if (harnessName === "greenhouse") {
    return ["allow-", "deny-", "verify-", "budget-", "predicate-", "input-"];
  }
  return [];
}

export async function testHarness(
  harnessDir: string,
  opts: { deployment?: string; fixturesRoot?: string; skipFixtures?: boolean } = {},
): Promise<TestHarnessResult> {
  const dir = resolve(harnessDir);
  const errors: string[] = [];
  const details: string[] = [];

  const v = validateAgentPath(dir);
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

  const agent = v.agent;
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
    resolveToolsFromDeployment(agent, deployment);
    details.push(`bindings OK (${basename(depPath)})`);
  } catch (e) {
    bindings_ok = false;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  let smoke_ok: boolean | null = null;
  if (bindings_ok) {
    try {
      const smoke = await runSmoke(agent, deployment, dir);
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

/**
 * Pack harness into a portable `.fausth.json` bundle (git/archives before registry).
 */
export function packHarness(
  harnessDir: string,
  outPath?: string,
): { out: string; files: string[] } {
  const dir = resolve(harnessDir);
  const name = basename(dir);
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

  // Stable key order for byte-identical TS↔Python packs
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const bundle = {
    format: "fausth-harness-bundle/v0.1",
    name,
    files: Object.fromEntries(files.map((f) => [f.path, f.content])),
  };

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
  return { out, files: files.map((f) => f.path) };
}
