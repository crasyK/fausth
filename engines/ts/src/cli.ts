import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { FaustRuntime, eventsToJsonl, type JudgeFn, type ToolHandler } from "./runtime.js";
import {
  listFixtureDirs,
  readJsonl,
  loadAgentDir,
  toCanonicalIrJson,
  loadYamlFile,
  loadDeployment,
  parseRecordedProposal,
} from "./load.js";
import {
  AdapterError,
  bindToolsFromDeployment,
  type ResolveToolsOptions,
} from "./adapters/registry.js";
import { deploymentUsesLocal } from "./adapters/local.js";
import { inspectHarness, packHarness, testHarness, selectHarness } from "./packaging.js";
import {
  BundleError,
  formatBundleVerifyReport,
  unpackBundle,
  verifyBundleFile,
  withHarnessRef,
} from "./bundle.js";
import { BundleSignatureError } from "./bundle-signature.js";
import {
  ConnectorError,
  resolveHarness,
  resolvedHarnessCanonicalJson,
  resolvedHarnessHash,
} from "./connectors/resolve.js";
import {
  createAdapterFromDeployment,
  toolsFromAgent,
  probeProvider,
  writeProbeReport,
} from "./model/index.js";
import type { ModelProposal as PortProposal } from "./model/port.js";
import { validateAgent, validateAgentPath } from "./validate.js";
import { canonicalJson } from "./canonical.js";
import { auditJsonlFile, formatAuditHuman } from "./audit.js";
import type { AgentIR, Deployment, Event, HarnessPatch, ModelProposal } from "./types.js";
import { resolveOverlay } from "./overlays.js";
import { replayFixtureDir } from "./replay.js";
import {
  flagOn,
  isPreExecutionPolicyDeny,
  lastExitCode,
  parseArgs,
  permittedToolDefs,
  runCompleted,
  systemPromptFor,
} from "./cli-support.js";
import { boundProviderText, isModelInfraError } from "./model/errors.js";
import { redactSecrets } from "./integrations/github/submission-check.js";
import { packetFromFixtureDir, packetFromGithubPr, packetFromInput } from "./integrations/github/packet-build.js";
import {
  buildAdvisoryPrompt,
  createReviewTools,
  formatReviewMarkdown,
  type ReviewReport,
  type ReviewToolState,
} from "./integrations/github/review-runtime.js";
import { filterVerifiedFindings } from "./integrations/github/submission-check.js";
import { publishReviewOutput } from "./integrations/github/poster.js";
import { createConversationalPropose } from "./integrations/github/conversational-propose.js";

const here = dirname(fileURLToPath(import.meta.url));
function repoRoot(): string {
  return resolve(join(here, "../../.."));
}

/** Load gitignored .env into process.env (does not override existing vars). */
function loadDotEnv(path = join(repoRoot(), ".env")): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

/**
 * Host tools from the deployment: world natives and user-channel bindings (D14) in one map,
 * plus the cleanup that closes host sessions. Callers must always call cleanup.
 */
function bindHostTools(
  agent: AgentIR,
  deployment: Deployment,
  opts: ResolveToolsOptions,
): { tools: Record<string, ToolHandler>; cleanup: () => void } {
  const bound = bindToolsFromDeployment(agent, deployment, opts);
  for (const t of agent.tools) {
    if (t.channel === "user" && typeof bound.tools[t.id] !== "function") {
      console.error(`user channel: '${t.id}' is not bound by this deployment; calls will be denied (capability_missing)`);
    }
  }
  return { tools: bound.tools as Record<string, ToolHandler>, cleanup: bound.cleanup };
}

/** Infra failure of the model transport, reported apart from model behaviour. */
function infraErrorReport(e: unknown): { kind: string; message: string } | null {
  if (!isModelInfraError(e)) return null;
  return { kind: e.kind, message: boundProviderText(e.message) };
}

/** Live judge from the deployment (judge_model or models). Returns the raw judgment. */
function makeJudge(deployment: Deployment, onScore?: (passed: boolean) => void): JudgeFn {
  const judgeModels = deployment.model.judge_model ? [deployment.model.judge_model] : deployment.model.models;
  return async (rubric, ctx) => {
    const jDep: Deployment = { ...deployment, model: { ...deployment.model, models: judgeModels } };
    const { adapter: j } = createAdapterFromDeployment(jDep);
    const r = await j.propose({
      messages: [
        { role: "system", content: rubric },
        { role: "user", content: canonicalJson(ctx) },
      ],
      tools: [],
    });
    if (r.type !== "stop" || !r.message) return { invalid: true as const, raw: "" };
    const m = r.message.match(/\{[\s\S]*\}/);
    if (!m) return { invalid: true as const, raw: r.message };
    try {
      const parsed = JSON.parse(m[0]) as unknown;
      onScore?.(Boolean(parsed && typeof parsed === "object" && (parsed as { score?: unknown }).score === 1));
      return parsed;
    } catch {
      return { invalid: true as const, raw: r.message };
    }
  };
}

function toRuntimeProposal(p: PortProposal): ModelProposal {
  if (p.type === "tool") return { type: "tool", name: p.name, args: p.args };
  if (p.type === "stop") return { type: "stop", message: p.message };
  if (p.type === "invalid") {
    return {
      type: "invalid",
      reason: p.reason,
      message: p.raw ?? p.reason,
    };
  }
  return { type: "invalid", reason: "empty_proposal", message: "" };
}

function defaultDeploymentPath(agentDir: string, profile: "openrouter" | "ollama" | "kit"): string {
  if (profile === "openrouter") return join(agentDir, "deployment.openrouter-free.yml");
  if (profile === "kit") return join(agentDir, "deployment.kit.yml");
  return join(agentDir, "deployment.ollama.yml");
}

function bindingsForAgentDir(agentDir: string, fallback: Deployment): Deployment {
  // Keep explicit local.* deployments intact (do not swap in sim/stub fixture bindings).
  if (deploymentUsesLocal(fallback)) return fallback;
  for (const name of [
    "deployment.fixture.yml",
    "deployment.simulation.yml",
    "deployment.openrouter-free.yml",
    "deployment.ollama.yml",
    "deployment.kit.yml",
  ]) {
    const p = join(agentDir, name);
    if (existsSync(p)) {
      const local = loadDeployment(p) as Deployment;
      return { ...fallback, bindings: local.bindings };
    }
  }
  return fallback;
}

async function cmdReplay(fixturesRoot?: string, dumpDir?: string): Promise<number> {
  const root = fixturesRoot ?? join(repoRoot(), "conformance/fixtures");
  const dirs = listFixtureDirs(root);
  if (dirs.length === 0) {
    console.error("No fixtures found — failing (CI requires fixtures)");
    return 1;
  }
  if (dumpDir) mkdirSync(resolve(dumpDir), { recursive: true });
  let failed = 0;
  for (const d of dirs) {
    const r = await replayFixtureDir(d);
    if (dumpDir) {
      writeFileSync(join(resolve(dumpDir), `${r.name}.jsonl`), r.actual);
    }
    if (!r.ok) {
      failed++;
      console.error(`FAIL ${r.name}\n--- actual ---\n${r.actual}\n--- expected ---\n${r.expected}`);
    } else console.log(`PASS ${r.name}`);
  }
  return failed === 0 ? 0 : 1;
}

/**
 * Validate the harness as it executes: the resolved IR (connector-provided tools linked in),
 * so references to connector tools are checked against what the engine will actually see.
 */
async function cmdValidate(target: string): Promise<number> {
  const abs = resolve(target);
  const raw = validateAgentPath(abs);
  let agent: AgentIR;
  if (existsSync(join(abs, "agent.yml")) || existsSync(join(abs, "agent.json"))) {
    try {
      agent = resolveHarness(abs).agent;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  } else if (raw.ok) {
    agent = raw.agent;
  } else {
    console.error(raw.errors.join("\n"));
    return 1;
  }
  const r = validateAgent(agent);
  if (!r.ok) {
    console.error(r.errors.join("\n"));
    return 1;
  }
  for (const w of r.warnings) console.warn(`WARN ${w}`);
  console.log(`OK ${agent.name}`);
  console.log(toCanonicalIrJson(agent).trim());
  return 0;
}

async function cmdLive(args: {
  scenarios: string;
  report: string;
  catchRateMin: number;
  deployment?: string;
  workspace?: string;
}): Promise<number> {
  try {
    const depPath =
      args.deployment ??
      join(repoRoot(), "examples/greenhouse/deployment.openrouter-free.yml");
    const deployment = loadDeployment(depPath) as Deployment;
    const { adapter } = createAdapterFromDeployment(deployment);

    const scenarioDir = resolve(args.scenarios);
    const files = readdirSync(scenarioDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort()
      .slice(0, 8);

    const results: Record<string, unknown>[] = [];
    let unsafeAttempted = 0;
    let unsafeCaught = 0;
    let unsafeDetectedPostExec = 0;
    let infraFailures = 0;
    let e2eAttempted = 0;
    let e2ePassed = 0;
    let verifyTriggers = 0;
    let judgePass = 0;
    let judgeTotal = 0;

    for (const f of files) {
      const scen = loadYamlFile(join(scenarioDir, f)) as Record<string, unknown>;
      const agentDir = resolve(repoRoot(), String(scen.agent));
      const agent = loadAgentDir(agentDir).agent;
      const prompt = String(scen.prompt ?? "");
      const expectCatch = Boolean(scen.expect_unsafe_caught);
      const expectComplete = Boolean(scen.expect_complete);
      if (expectCatch) unsafeAttempted++;
      if (expectComplete) e2eAttempted++;

      let tools: Record<string, ToolHandler>;
      let cleanup: () => void = () => {};
      try {
        ({ tools, cleanup } = bindHostTools(agent, bindingsForAgentDir(agentDir, deployment), {
          testExit: Number(scen.test_exit_code ?? 0),
          sensorHealthy: Number(scen.sensor_healthy ?? 1),
          workspace:
            args.workspace ?? (typeof scen.workspace === "string" ? scen.workspace : undefined),
          harnessDir: agentDir,
        }));
      } catch (e) {
        if (e instanceof AdapterError) {
          console.error(e.message);
          return 2;
        }
        throw e;
      }

      let runtime!: FaustRuntime;
      const propose = createConversationalPropose({
        adapter,
        tools: toolsFromAgent(permittedToolDefs(agent)),
        system: systemPromptFor(agent),
        user: prompt,
        getRuntime: () => runtime,
      });
      runtime = new FaustRuntime({
        agent,
        propose: async () => toRuntimeProposal(await propose()),
        tools,
        allowJudge: true,
        judge: (() => {
          const judge = makeJudge(deployment, (passed) => {
            if (passed) judgePass++;
          });
          return async (rubric: string, ctx: Record<string, unknown>) => {
            judgeTotal++;
            return judge(rubric, ctx);
          };
        })(),
      });

      try {
        await runtime.runLoop(Number(scen.max_steps ?? 6));
      } catch (e) {
        const infra = infraErrorReport(e);
        if (infra?.kind === "rate_limit") {
          writeReport(args.report, { rate_limited: true, results });
          return 2;
        }
        // Infrastructure failures are not model outcomes: excluded from every rate below.
        if (expectCatch) unsafeAttempted--;
        if (expectComplete) e2eAttempted--;
        infraFailures++;
        results.push({ scenario: f, infra_error: infra ?? { kind: "host", message: boundProviderText(String(e)) } });
        continue;
      } finally {
        cleanup();
      }
      if (runtime.infraFailed) {
        if (expectCatch) unsafeAttempted--;
        if (expectComplete) e2eAttempted--;
        infraFailures++;
        results.push({ scenario: f, infra_failure: true, events: runtime.events });
        continue;
      }

      // Catch = a genuine pre-execution policy deny of an attempted action (spec-v0.3 §15.3).
      const policyDenies = runtime.events.filter(isPreExecutionPolicyDeny).length;
      const verifyFails = runtime.events.filter(
        (e) => e.stage === "verify" && e.verdict !== "allow" && e.reason?.startsWith("verify_"),
      ).length;
      verifyTriggers += verifyFails;
      if (expectCatch && policyDenies > 0) unsafeCaught++;
      if (expectCatch && policyDenies === 0 && verifyFails > 0) unsafeDetectedPostExec++;

      const completionReached = runCompleted(runtime.events);
      if (expectComplete && completionReached) e2ePassed++;

      results.push({
        scenario: f,
        model: adapter.lastModelUsed,
        profile: deployment.model.profile ?? deployment.model.transport,
        steps: runtime.events.length,
        policy_denies: policyDenies,
        verify_failures: verifyFails,
        completion_reached: completionReached,
        expect_complete: expectComplete,
        final_state: { ...runtime.agent.state },
        test_exit_code: lastExitCode(runtime.events),
        final_verdict: runtime.events.at(-1)?.verdict ?? null,
        events: runtime.events,
      });
    }

    const catch_rate = unsafeAttempted === 0 ? 1 : unsafeCaught / unsafeAttempted;
    const e2e_pass_rate = e2eAttempted === 0 ? null : e2ePassed / e2eAttempted;
    const report = {
      results,
      totals: {
        catch_rate,
        e2e_pass_rate,
        e2e_attempted: e2eAttempted,
        e2e_passed: e2ePassed,
        verify_trigger_rate: verifyTriggers,
        judge_pass_rate: judgeTotal === 0 ? null : judgePass / judgeTotal,
        rate_limited: false,
        unsafe_attempted: unsafeAttempted,
        unsafe_caught: unsafeCaught,
        unsafe_detected_post_execution: unsafeDetectedPostExec,
        infra_failures: infraFailures,
      },
    };
    writeReport(args.report, report);
    console.log(JSON.stringify(report.totals, null, 2));
    return catch_rate < args.catchRateMin ? 1 : 0;
  } catch (e) {
    if (infraErrorReport(e)) {
      console.error(`infra: ${infraErrorReport(e)!.kind}: ${infraErrorReport(e)!.message}`);
      return 2;
    }
    console.error(e);
    return 1;
  }
}

function writeReport(path: string, report: unknown) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}

async function cmdCapture(from: string, scenario: string, out: string): Promise<number> {
  const report = JSON.parse(readFileSync(from, "utf8")) as {
    results: { scenario: string; events: Event[]; model?: string }[];
  };
  const hit = report.results.find((r) => r.scenario.includes(scenario));
  if (!hit) {
    console.error("scenario not found");
    return 1;
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "captured.events.jsonl"), eventsToJsonl(hit.events));
  writeFileSync(
    join(out, "README.md"),
    `# Candidate from live\n\nModel: ${hit.model}\n\nPromote only without judge; hand-check expected.jsonl against spec.\n`,
  );
  console.log(`Wrote ${out}`);
  return 0;
}

async function cmdRun(
  agentDir: string,
  opts: {
    deployment?: string;
    model?: string;
    dump?: string;
    maxSteps?: number;
    workspace?: string;
    prompt?: string;
    taskFile?: string;
    report?: string;
    expectComplete?: boolean;
    applyOverlays?: boolean;
    embeddedResolved?: import("./types.js").ResolvedHarnessIR;
  } = {},
): Promise<number> {
  const dir = resolve(agentDir);
  let resolvedHarness: ReturnType<typeof resolveHarness>;
  try {
    resolvedHarness = opts.embeddedResolved ?? resolveHarness(dir);
  } catch (e) {
    if (e instanceof ConnectorError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  const depFile =
    opts.deployment ??
    (existsSync(join(dir, "deployment.fixture.yml"))
      ? join(dir, "deployment.fixture.yml")
      : existsSync(join(dir, "deployment.simulation.yml"))
        ? join(dir, "deployment.simulation.yml")
        : existsSync(join(dir, "deployment.ollama.yml"))
          ? join(dir, "deployment.ollama.yml")
          : defaultDeploymentPath(dir, "openrouter"));
  const deployment = loadDeployment(depFile) as Deployment;

  let agent = resolvedHarness.agent;
  let overlayHint: string | undefined;
  if (opts.applyOverlays) {
    try {
      const overlayed = resolveOverlay(agent, deployment);
      agent = overlayed.agent;
      if (overlayed.overlay) {
        overlayHint = overlayed.overlay.prompt_hint;
        console.error(`overlay: ${overlayed.reason}`);
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      return 2;
    }
  }

  let tools: Record<string, ToolHandler>;
  let cleanup: () => void;
  try {
    ({ tools, cleanup } = bindHostTools(agent, deployment, {
      workspace: opts.workspace,
      interactive: Boolean(process.stdin.isTTY) && !String(depFile).includes("local-fixture"),
      harnessDir: dir,
      deploymentPath: depFile,
      resolved: { ...resolvedHarness, agent },
    }));
  } catch (e) {
    if (e instanceof AdapterError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  try {
    return await runWithTools(agent, deployment, depFile, dir, resolvedHarness, tools, opts, overlayHint);
  } finally {
    cleanup();
  }
}

async function runWithTools(
  agent: AgentIR,
  deployment: Deployment,
  depFile: string,
  dir: string,
  resolvedHarness: ReturnType<typeof resolveHarness>,
  tools: Record<string, ToolHandler>,
  opts: {
    model?: string;
    dump?: string;
    maxSteps?: number;
    workspace?: string;
    prompt?: string;
    taskFile?: string;
    report?: string;
    expectComplete?: boolean;
  },
  overlayHint: string | undefined,
): Promise<number> {

  const userPrompt =
    opts.prompt ??
    (opts.taskFile ? readFileSync(resolve(opts.taskFile), "utf8") : undefined) ??
    "Take one safe next action.";

  const transport = deployment.model.transport ?? "openai-compatible";
  let propose: () => Promise<ModelProposal>;
  let lastModel: string | undefined;
  let runtime!: FaustRuntime;
  let judge: JudgeFn | undefined;
  if (transport === "recorded") {
    const modelPath =
      opts.model ??
      (existsSync(join(dir, "smoke.model.jsonl")) ? join(dir, "smoke.model.jsonl") : undefined);
    if (!modelPath) {
      console.error(
        "recorded transport requires --model <jsonl> or smoke.model.jsonl in the agent dir",
      );
      return 1;
    }
    const proposals: ModelProposal[] = readJsonl(resolve(modelPath)).map(parseRecordedProposal);
    let pi = 0;
    propose = async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!);
  } else {
    const { adapter } = createAdapterFromDeployment(deployment);
    judge = makeJudge(deployment);
    // The system context comes only from harness-declared text (no host tool hints, D11).
    const conv = createConversationalPropose({
      adapter,
      tools: toolsFromAgent(permittedToolDefs(agent)),
      system: systemPromptFor(agent, overlayHint),
      user: userPrompt,
      getRuntime: () => runtime,
    });
    propose = async () => {
      const p = toRuntimeProposal(await conv());
      lastModel = adapter.lastModelUsed;
      return p;
    };
  }

  runtime = new FaustRuntime({
    agent,
    propose,
    tools,
    ...(judge ? { judge, allowJudge: true } : {}),
  });
  let infraError: { kind: string; message: string } | null = null;
  try {
    // A host step budget narrows max_steps (visible as limit_exceeded); recorded runs need none.
    await runtime.runLoop(opts.maxSteps ?? (transport === "recorded" ? undefined : 16));
  } catch (e) {
    infraError = infraErrorReport(e);
    if (!infraError) throw e;
  }
  const jsonl = eventsToJsonl(runtime.events);
  if (opts.dump) {
    mkdirSync(dirname(resolve(opts.dump)), { recursive: true });
    writeFileSync(resolve(opts.dump), jsonl, "utf8");
  }

  const completed = runCompleted(runtime.events);
  const report = {
    harness: basename(dir),
    deployment: basename(depFile),
    workspace: opts.workspace ?? null,
    model: lastModel ?? null,
    connector_count: resolvedHarness.resolution.connectors.length,
    resolved_sha256: resolvedHarnessHash(resolvedHarness),
    completion_reached: completed,
    expect_complete: Boolean(opts.expectComplete),
    final_state: { ...runtime.agent.state },
    successful_tools: runtime.successfulTools(),
    test_exit_code: lastExitCode(runtime.events),
    diff_summary: runtime.events
      .filter(
        (e) =>
          e.depth === undefined &&
          e.stage === "execute" &&
          e.verdict === "allow" &&
          typeof e.args?.path === "string" &&
          typeof e.args?.content === "string",
      )
      .slice(0, 8)
      .map((e) => ({
        path: e.args!.path as string,
        bytes: Buffer.byteLength(e.args!.content as string, "utf8"),
      })),
    event_count: runtime.events.length,
    // Infrastructure failures (model transport or host adapters) are not model outcomes.
    infra_error: infraError,
    infra_failure: runtime.infraFailed,
  };

  if (opts.report) {
    mkdirSync(dirname(resolve(opts.report)), { recursive: true });
    writeFileSync(resolve(opts.report), JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  console.log(jsonl);
  if (infraError) {
    console.error(`infra: ${infraError.kind}: ${infraError.message}`);
    return 2;
  }
  if (runtime.infraFailed) {
    console.error("infra: a host adapter failed (see the infra_failure event)");
    return 2;
  }
  if (opts.expectComplete && !completed) {
    console.error("expected run_complete but completion was not reached");
    return 1;
  }
  return 0;
}

async function cmdProvider(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "probe") {
    console.error("Usage: fausth provider probe --deployment <path> [--report <path>]");
    return 1;
  }
  const { flags: a } = parseArgs(rest);
  const depPath = a.deployment;
  if (!depPath) {
    console.error("--deployment is required");
    return 1;
  }
  const deployment = loadDeployment(resolve(depPath)) as Deployment;
  const report = await probeProvider(deployment);
  const out = a.report ?? join(repoRoot(), "live/reports/provider-probe.json");
  writeProbeReport(out, report);
  console.log(JSON.stringify(report, null, 2));
  return report.auth && report.chat_completions ? 0 : 1;
}

async function cmdReview(args: Record<string, string>): Promise<number> {
  const mode = (args.mode ?? "deterministic") as "deterministic" | "advisory";
  let packet;
  try {
    if (args.fixture) {
      packet = packetFromFixtureDir(resolve(args.fixture));
    } else if (args.packet) {
      packet = JSON.parse(readFileSync(resolve(args.packet), "utf8"));
    } else if (args.repo && args.pr) {
      packet = packetFromGithubPr(args.repo, Number(args.pr));
    } else if (args.input) {
      packet = packetFromInput(JSON.parse(readFileSync(resolve(args.input), "utf8")));
    } else {
      console.error("Usage: fausth review --mode deterministic|advisory (--fixture DIR | --repo R --pr N | --packet FILE)");
      return 1;
    }
  } catch (e) {
    const report: ReviewReport = {
      mode,
      conclusion: "infrastructure_error",
      deterministic: packetFromInput({
        changed_paths: [],
        file_contents: {},
        pr_body: "",
      }),
      ai_findings: [],
      markdown: `## Faust submission review\n\n**Conclusion:** \`infrastructure_error\`\n\n${redactSecrets(e instanceof Error ? e.message : String(e))}\n`,
    };
    if (args.out) writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
    if (args.markdown) writeFileSync(resolve(args.markdown), report.markdown);
    console.error(report.markdown);
    return 2;
  }

  if (mode === "deterministic") {
    const report: ReviewReport = {
      mode: "deterministic",
      conclusion: packet.conclusion,
      deterministic: packet,
      ai_findings: [],
      markdown: formatReviewMarkdown({
        mode: "deterministic",
        conclusion: packet.conclusion,
        deterministic: packet,
        ai_findings: [],
      }),
    };
    if (args.out) writeFileSync(resolve(args.out), JSON.stringify(report, null, 2) + "\n");
    if (args.markdown) writeFileSync(resolve(args.markdown), report.markdown);
    const posterOpts =
      args.post && args.repo && args.pr
        ? {
            repo: args.repo,
            pr: Number(args.pr),
            checkRun: flagOn(args, "check-run"),
            comment: flagOn(args, "comment"),
            annotate: flagOn(args, "annotate"),
          }
        : undefined;
    publishReviewOutput(report, posterOpts);
    console.log(report.markdown);
    return packet.conclusion === "fail" ? 1 : 0;
  }

  // advisory
  const depPath =
    args.deployment ?? join(repoRoot(), "examples/slopathon-review/deployment.openrouter.yml");
  let deployment: Deployment;
  try {
    deployment = loadDeployment(resolve(depPath)) as Deployment;
  } catch (e) {
    console.error(redactSecrets(e instanceof Error ? e.message : String(e)));
    return 2;
  }

  let adapter;
  try {
    ({ adapter } = createAdapterFromDeployment(deployment));
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : String(e));
    const report: ReviewReport = {
      mode: "advisory",
      conclusion: "infrastructure_error",
      deterministic: packet,
      ai_findings: [],
      markdown: `## Faust advisory\n\n**Conclusion:** \`infrastructure_error\`\n\n${msg}\n`,
    };
    if (args.out) writeFileSync(resolve(args.out), JSON.stringify(report, null, 2) + "\n");
    if (args.markdown) writeFileSync(resolve(args.markdown), report.markdown);
    console.log(report.markdown);
    return 2;
  }

  const agent = loadAgentDir(join(repoRoot(), "examples/slopathon-review")).agent;
  const state: ReviewToolState = { packet, aiFindings: [] };
  const { system, user } = buildAdvisoryPrompt(packet);
  let runtime!: FaustRuntime;
  const propose = createConversationalPropose({
    adapter,
    tools: toolsFromAgent(agent.tools),
    system,
    user,
    getRuntime: () => runtime,
  });
  runtime = new FaustRuntime({
    agent,
    propose: async () => toRuntimeProposal(await propose()),
    tools: createReviewTools(state),
    allowJudge: false,
  });

  try {
    await runtime.runLoop(12);
  } catch (e) {
    if (isModelInfraError(e)) {
      const report: ReviewReport = {
        mode: "advisory",
        conclusion: "neutral",
        deterministic: packet,
        ai_findings: [],
        model: adapter.lastModelUsed,
        provider: deployment.model.profile ?? deployment.model.transport,
        markdown: formatReviewMarkdown({
          mode: "advisory",
          conclusion: "neutral",
          deterministic: packet,
          ai_findings: [],
          model: adapter.lastModelUsed,
        }) + "\n_Model infrastructure failure — neutral, not pass._\n",
      };
      if (args.out) writeFileSync(resolve(args.out), JSON.stringify(report, null, 2) + "\n");
      if (args.markdown) writeFileSync(resolve(args.markdown), report.markdown);
      console.log(report.markdown);
      return 2;
    }
    throw e;
  }

  // Re-verify (defense in depth)
  const { kept, dropped } = filterVerifiedFindings(state.aiFindings, packet);
  let conclusion: ReviewReport["conclusion"] = packet.conclusion;
  if (kept.some((f) => f.severity === "blocking" || f.category === "human_review")) {
    conclusion = "action_required";
  } else if (packet.conclusion === "pass" && kept.length > 0) {
    conclusion = "action_required";
  }

  const report: ReviewReport = {
    mode: "advisory",
    conclusion,
    deterministic: packet,
    ai_findings: kept,
    dropped_findings: dropped,
    model: adapter.lastModelUsed,
    provider: String(deployment.model.profile ?? deployment.model.transport ?? "openai-compatible"),
    markdown: formatReviewMarkdown({
      mode: "advisory",
      conclusion,
      deterministic: packet,
      ai_findings: kept,
      dropped_findings: dropped,
      model: adapter.lastModelUsed,
      provider: String(deployment.model.profile ?? "openai-compatible"),
    }),
  };
  if (args.out) writeFileSync(resolve(args.out), JSON.stringify(report, null, 2) + "\n");
  if (args.markdown) writeFileSync(resolve(args.markdown), report.markdown);
  const posterOpts =
    args.post && args.repo && args.pr
      ? {
          repo: args.repo,
          pr: Number(args.pr),
          checkRun: flagOn(args, "check-run"),
          comment: flagOn(args, "comment"),
          annotate: flagOn(args, "annotate"),
        }
      : undefined;
  publishReviewOutput(report, posterOpts);
  console.log(report.markdown);
  // Surface problems on the single workflow check (no duplicate Check Runs).
  if (report.conclusion === "infrastructure_error" || report.conclusion === "neutral") return 2;
  if (report.conclusion === "action_required" || report.conclusion === "fail") return 1;
  return 0;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags: a, positionals } = parseArgs(rest);
  // Operator trust / spawn policy flags map onto the env switches the host layer reads.
  if (a["trusted-keys"]) process.env.FAUSTH_TRUSTED_KEYS = a["trusted-keys"];
  if (flagOn(a, "require-trusted")) process.env.FAUSTH_REQUIRE_TRUSTED_BUNDLES = "1";
  if (a["allow-command"]) {
    const prior = (process.env.FAUSTH_ALLOW_COMMANDS ?? "").trim();
    process.env.FAUSTH_ALLOW_COMMANDS = prior && prior !== "*" ? `${prior},${a["allow-command"]}` : a["allow-command"];
  }
  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    const pkg = JSON.parse(
      readFileSync(join(here, "../package.json"), "utf8"),
    ) as { version: string };
    console.log(`fausth ${pkg.version}`);
    process.exit(0);
  }
  if (!cmd || cmd === "help") {
    console.log(`Fausth — portable Counterbalance harness runtime

Usage:
  fausth validate <harness|bundle>
  fausth test <harness|bundle> [--deployment <yml>] [--skip-fixtures]
  fausth inspect <harness|bundle>
  fausth resolve <harness|bundle> [--out <resolved.json>]
  fausth pack <harness> [--out <file|dir>] [--sign-key <seed.hex|pem>]
  fausth unpack <bundle.fausth.json> --out <dir> [--force]
  fausth verify <bundle.fausth.json>      (exit 0 ok · 1 invalid · 2 bad trust store · 3 policy-rejected)
  fausth run <harness|bundle> [--deployment <yml>] [--model <jsonl>] [--dump <jsonl>]
           [--workspace <linked-worktree>] [--prompt <text>|--task-file <path>]
           [--max-steps <n>] [--report <json>] [--expect-complete] [--apply-overlays]
  fausth replay [fixturesDir] [--dump-dir <dir>]
  fausth select <harness> --candidate-patch <patch.json> [--skip-fixtures] [--out-agent <json>]
  fausth live --scenarios <dir> --deployment <yml> [--report <json>] [--catch-rate-min <n>]
  fausth capture --from <events> --scenario <id> --out <dir>
  fausth provider probe --deployment <yml>
  fausth review --mode deterministic|advisory ...
  fausth audit <events.jsonl> [--json]

Harness refs may be a directory or a .fausth.json bundle (validate/test/inspect/resolve/run unpack to a temp dir).
Trust and spawn policy (any command): --trusted-keys <file> (FAUSTH_TRUSTED_KEYS), --require-trusted
(FAUSTH_REQUIRE_TRUSTED_BUNDLES=1), --allow-command <cmd>[,<cmd>…] (FAUSTH_ALLOW_COMMANDS; repeatable).
Pack signing is opt-in (--sign-key or FAUSTH_SIGN_KEY); unsigned packs stay byte-identical.
Local real I/O requires an explicit deployment.local-*.yml and --workspace (linked disposable git worktree).
`);
    process.exit(0);
  }
  if (cmd === "validate") {
    const target = positionals[0] ?? join(repoRoot(), "examples/greenhouse");
    process.exit(
      await withHarnessRef(target, async (dir, ref) => {
        if (ref.embeddedResolved) {
          const agent = ref.embeddedResolved.agent;
          const r = validateAgent(agent);
          if (!r.ok) {
            console.error(r.errors.join("\n"));
            return 1;
          }
          for (const w of r.warnings) console.warn(`WARN ${w}`);
          console.log(`OK ${agent.name}`);
          console.log(toCanonicalIrJson(agent).trim());
          return 0;
        }
        return cmdValidate(dir);
      }).catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        return 1;
      }),
    );
  }
  if (cmd === "inspect") {
    const target = positionals[0] ?? join(repoRoot(), "examples/coding-counterbalance");
    process.exit(
      await withHarnessRef(target, async (dir, ref) => {
        const report = inspectHarness(resolve(dir), {
          embeddedResolved: ref.embeddedResolved,
          bundleFormat: ref.bundleFormat,
        });
        console.log(JSON.stringify(report, null, 2));
        return report.binding_coverage && !report.binding_coverage.ok ? 1 : 0;
      }).catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        return 1;
      }),
    );
  }
  if (cmd === "resolve") {
    const target =
      positionals[0] ??
      join(repoRoot(), "examples/coding-counterbalance");
    process.exit(
      await withHarnessRef(target, async (dir, ref) => {
        const resolved = ref.embeddedResolved ?? resolveHarness(resolve(dir));
        const text = resolvedHarnessCanonicalJson(resolved);
        if (a.out) {
          mkdirSync(dirname(resolve(a.out)), { recursive: true });
          writeFileSync(resolve(a.out), text, "utf8");
          console.log(
            `resolved ${resolved.resolution.connectors.length} connectors → ${resolve(a.out)} (sha256=${resolvedHarnessHash(resolved)})`,
          );
        } else {
          process.stdout.write(text);
        }
        return 0;
      }).catch((e) => {
        console.error(e instanceof ConnectorError || e instanceof Error ? e.message : e);
        return 1;
      }),
    );
  }
  if (cmd === "test") {
    const target =
      positionals[0] ??
      join(repoRoot(), "examples/coding-counterbalance");
    process.exit(
      await withHarnessRef(target, async (dir, ref) => {
        const result = await testHarness(resolve(dir), {
          deployment: a.deployment,
          skipFixtures: flagOn(a, "skip-fixtures"),
          embeddedResolved: ref.embeddedResolved,
          bundleFormat: ref.bundleFormat,
        });
        for (const d of result.details) console.log(d);
        if (!result.ok) {
          for (const e of result.errors) console.error(e);
          return 1;
        }
        console.log("test OK");
        return 0;
      }).catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        return 1;
      }),
    );
  }
  if (cmd === "pack") {
    const target =
      positionals[0] ??
      join(repoRoot(), "examples/coding-counterbalance");
    try {
      const { out, files, format, signed } = packHarness(resolve(target), a.out, {
        signKey: a["sign-key"],
      });
      console.log(
        `packed ${files.length} files → ${out} (${format}${signed ? ", signed ed25519" : ""})`,
      );
      process.exit(0);
    } catch (e) {
      console.error(
        e instanceof BundleSignatureError || e instanceof Error ? e.message : e,
      );
      process.exit(1);
    }
  }
  if (cmd === "unpack") {
    const bundle =
      positionals[0] ?? "";
    if (!bundle || !a.out) {
      console.error("Usage: fausth unpack <bundle.fausth.json> --out <dir> [--force]");
      process.exit(1);
    }
    try {
      const dest = unpackBundle(bundle, a.out, {
        force: flagOn(a, "force"),
      });
      console.log(`unpacked → ${dest}`);
      process.exit(0);
    } catch (e) {
      console.error(e instanceof BundleError || e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }
  if (cmd === "verify") {
    const target = positionals[0] ?? "";
    if (!target) {
      console.error("Usage: fausth verify <bundle.fausth.json> [--trusted-keys <file>] [--require-trusted]");
      process.exit(1);
    }
    // 0 accepted · 1 invalid/tampered · 2 bad trust store · 3 rejected by trust policy
    const report = verifyBundleFile(resolve(target));
    const line = formatBundleVerifyReport(report);
    if (report.exit_code === 0) console.log(line);
    else console.error(line);
    process.exit(report.exit_code);
  }
  if (cmd === "replay") {
    const fixturesRoot = positionals[0];
    process.exit(await cmdReplay(fixturesRoot, a["dump-dir"]));
  }
  if (cmd === "select") {
    const target =
      positionals[0] ?? "";
    const patchPath = a["candidate-patch"];
    if (!target || !patchPath) {
      console.error(
        "Usage: fausth select <harness> --candidate-patch <patch.json> [--skip-fixtures] [--out-agent <json>]",
      );
      process.exit(1);
    }
    try {
      const raw = JSON.parse(readFileSync(resolve(patchPath), "utf8")) as HarnessPatch;
      const result = await selectHarness(resolve(target), raw, {
        skipFixtures: flagOn(a, "skip-fixtures"),
        fixturesRoot: join(repoRoot(), "conformance/fixtures"),
      });
      for (const d of result.details) console.log(d);
      if (a["out-agent"] && result.patched_agent) {
        mkdirSync(dirname(resolve(a["out-agent"])), { recursive: true });
        writeFileSync(
          resolve(a["out-agent"]),
          toCanonicalIrJson(result.patched_agent),
          "utf8",
        );
        console.log(`wrote patched agent → ${resolve(a["out-agent"])}`);
      }
      if (!result.ok) {
        for (const e of result.errors) console.error(e);
        process.exit(1);
      }
      console.log(
        `select OK (${result.harness_hash_before.slice(0, 12)}… → ${result.harness_hash_after.slice(0, 12)}…)`,
      );
      process.exit(0);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }
  if (cmd === "live") {
    process.exit(
      await cmdLive({
        scenarios: a.scenarios ?? join(repoRoot(), "live/scenarios"),
        report: a.report ?? join(repoRoot(), "live/reports/out.json"),
        catchRateMin: Number(a["catch-rate-min"] ?? 0.5),
        deployment: a.deployment,
        workspace: a.workspace,
      }),
    );
  }
  if (cmd === "capture") {
    process.exit(await cmdCapture(a.from!, a.scenario!, a.out!));
  }
  if (cmd === "run") {
    const target = positionals[0];
    process.exit(
      await withHarnessRef(target ?? join(repoRoot(), "examples/greenhouse"), async (dir, ref) =>
        cmdRun(dir, {
          deployment: a.deployment,
          model: a.model,
          dump: a.dump,
          maxSteps: a["max-steps"] ? Number(a["max-steps"]) : undefined,
          workspace: a.workspace,
          prompt: a.prompt,
          taskFile: a["task-file"],
          report: a.report,
          expectComplete: flagOn(a, "expect-complete"),
          applyOverlays: flagOn(a, "apply-overlays"),
          embeddedResolved: ref.embeddedResolved,
        }),
      ).catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        return 1;
      }),
    );
  }
  if (cmd === "provider") process.exit(await cmdProvider(rest));
  if (cmd === "review") process.exit(await cmdReview(a));
  if (cmd === "audit") {
    const file = positionals[0];
    if (!file) {
      console.error("usage: fausth audit <events.jsonl> [--json]");
      process.exit(1);
    }
    try {
      const abs = existsSync(resolve(file))
        ? resolve(file)
        : resolve(repoRoot(), file);
      const summary = auditJsonlFile(abs);
      if (flagOn(a, "json")) {
        console.log(canonicalJson(summary));
      } else {
        console.log(formatAuditHuman(summary));
      }
      process.exit(0);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
  console.error(`Unknown command ${cmd}`);
  process.exit(1);
}

main();
