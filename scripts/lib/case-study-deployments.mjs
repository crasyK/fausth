/**
 * Deployment materialization for case-study runs.
 *
 * - KIT model variants (SCR-4): derived from the manifest's kit template,
 *   content-hash named, regenerated on every start (incl. --resume). Only
 *   commands whose argv[0] is literally `pytest` are re-pointed at the repo's
 *   pytest resolver; every other command (e.g. `node --test`) is untouched.
 * - User channel (D14, engine contract in engines/ts/src/adapters/user-channel.ts):
 *   user-channel tools — harness `channel: user`, bindings to the removed
 *   auto-answer natives (local.user_ask*, user.ask, stub.ask), existing `user:`
 *   bindings, or manifest `user_channel.tools` — are bound as
 *   `bindings.<tool> = { user: { source, answers | model, system_prompt_file, context_file } }`
 *   in a per-attempt deployment written to the attempt dir. Every file the binding
 *   names is placed next to that deployment and referenced by a relative path
 *   (the engine resolves them inside the deployment's directory, outside the
 *   agent's workspace). Recorded mode always binds `source: recorded`; live mode
 *   uses `user_channel.source` (default: the task's scripted `user_sim` answers).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const require = createRequire(join(repoRoot, "engines/ts/package.json"));
const YAML = require("yaml");

/** Natives the D14 engine removed: they answered the user from the model's own args. */
export const REMOVED_USER_NATIVES = new Set(["stub.ask", "user.ask", "local.user_ask", "local.user_ask_auto"]);
export const USER_CHANNEL_SOURCES = new Set(["recorded", "simulator", "human"]);
/** Optional simulator transport overrides passed through from the manifest. */
const SIMULATOR_PASSTHROUGH = ["profile", "base_url", "api_key_env", "max_tokens"];

/**
 * Legacy auto-checkpoint natives expressed as recorded user scripts. When a
 * harness declares a checkpoint tool on the user channel (contract: checkpoints
 * are user decisions) its native binding is no longer allowed; the same
 * auto-approve / auto-correct protocol is then answered by the recorded user.
 */
export const LEGACY_AUTO_SCRIPTS = {
  "local.user_approve_auto": [{ output: { approved: 1 }, state_transition: { set: { plan_approved: 1 } } }],
  "local.user_correct_auto": [{ output: { ok: 1 }, state_transition: { set: { open_todos: 0 } } }],
};

/** @param {string} p @param {string} root */
function resolveRepoPath(p, root = repoRoot) {
  return isAbsolute(p) ? p : join(root, p);
}

/** Repo pytest resolver (shell wrapper → .venv pytest → PATH). */
export function defaultPytestBin(root = repoRoot) {
  const runner = join(root, "scripts", "pytest-runner.sh");
  if (existsSync(runner)) return runner;
  const venv = join(root, ".venv", "bin", "pytest");
  return existsSync(venv) ? venv : "pytest";
}

/**
 * Re-point `pytest` commands at the resolver; leave every other command as is.
 * @param {Record<string, any>} dep parsed deployment (not mutated)
 * @param {string} pytestBin
 */
export function resolvePytestCommands(dep, pytestBin) {
  const out = structuredClone(dep);
  const cmds = out.world?.commands;
  if (!cmds || typeof cmds !== "object") return out;
  for (const [key, argv] of Object.entries(cmds)) {
    if (Array.isArray(argv) && argv.length && argv[0] === "pytest") {
      cmds[key] = [pytestBin, ...argv.slice(1)];
    }
  }
  return out;
}

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Materialize the KIT deployment for one model (deterministic, hash-named).
 * @param {{ modelId: string, runRoot: string, templatePath: string, root?: string, pytestBin?: string }} opts
 * @returns {{ path: string, abs: string, sha256: string, model_id: string }}
 */
export function materializeKitDeployment(opts) {
  const root = opts.root ?? repoRoot;
  const template = YAML.parse(readFileSync(resolveRepoPath(opts.templatePath, root), "utf8"));
  template.model = { ...(template.model ?? {}), models: [opts.modelId] };
  const dep = resolvePytestCommands(template, opts.pytestBin ?? defaultPytestBin(root));
  const text = YAML.stringify(dep);
  const digest = sha256(text);
  const safe = String(opts.modelId).replace(/[^a-zA-Z0-9._-]+/g, "_");
  const dir = join(opts.runRoot, "deployments");
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `local-kit__${safe}__${digest.slice(0, 12)}.yml`);
  if (!existsSync(abs) || sha256(readFileSync(abs, "utf8")) !== digest) {
    writeFileSync(abs, text);
  }
  return { path: relative(root, abs), abs, sha256: digest, model_id: opts.modelId };
}

/**
 * Tools that sit on the user channel for a given harness + deployment.
 * @param {Record<string, any>} dep
 * @param {{ declared?: string[], explicit?: string[] | null }} opts
 */
export function userChannelTools(dep, opts = {}) {
  const tools = new Set([...(opts.declared ?? []), ...(opts.explicit ?? [])]);
  for (const [tool, binding] of Object.entries(dep.bindings ?? {})) {
    if (!binding || typeof binding !== "object") continue;
    if (REMOVED_USER_NATIVES.has(String(binding.native ?? ""))) tools.add(tool);
    if (binding.user && typeof binding.user === "object") tools.add(tool);
  }
  return [...tools].sort();
}

/**
 * Tool definitions of a harness dir (agent.json IR or agent.yml).
 * @param {string} harnessDir
 * @returns {Array<Record<string, any>>}
 */
export function harnessTools(harnessDir) {
  for (const name of ["agent.json", "agent.yml"]) {
    const p = join(harnessDir, name);
    if (!existsSync(p)) continue;
    try {
      const doc = name.endsWith(".json")
        ? JSON.parse(readFileSync(p, "utf8"))
        : YAML.parse(readFileSync(p, "utf8"));
      return Array.isArray(doc?.tools) ? doc.tools : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Tool ids a harness declares on the user channel (`channel: user`).
 * @param {string} harnessDir
 */
export function declaredUserChannelTools(harnessDir) {
  return harnessTools(harnessDir)
    .filter((t) => t && (t.channel === "user" || t.channel?.kind === "user"))
    .map((t) => String(t.id));
}

/**
 * Expand `{task_dir}` / `{task_id}` and resolve against the repo root.
 * @param {string | undefined | null} p
 * @param {{ taskAbsDir: string, taskId: string, root?: string }} ctx
 */
export function resolveTaskTemplatePath(p, ctx) {
  if (p == null || p === "") return null;
  const expanded = String(p)
    .replaceAll("{task_dir}", ctx.taskAbsDir)
    .replaceAll("{task_id}", ctx.taskId);
  return resolveRepoPath(expanded, ctx.root ?? repoRoot);
}

/**
 * Tool output for one scripted answer. Objects with `output` are envelopes;
 * plain values fill the tool's single required output property (string → text,
 * integer/boolean → yes/no), mirroring the engine's human-answer coercion.
 * @param {Record<string, any> | undefined} toolDef
 * @param {unknown} answer
 * @returns {Record<string, any> | null} tool result envelope
 */
export function answerEnvelope(toolDef, answer) {
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const a = /** @type {Record<string, any>} */ (answer);
    if (a.output && typeof a.output === "object") {
      return { output: a.output, ...(a.state_transition ? { state_transition: a.state_transition } : {}) };
    }
    return { output: a };
  }
  const schema = toolDef?.output ?? { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };
  const props = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : Object.keys(props);
  if (required.length !== 1) return null;
  const key = required[0];
  const type = props[key]?.type;
  const text = String(answer);
  if (type === "string" || type === undefined) return { output: { [key]: text } };
  if (type === "integer" || type === "number" || type === "boolean") {
    const yes = /^(y|yes|1|true)\b/i.test(text.trim());
    const no = /^(n|no|0|false)\b/i.test(text.trim());
    if (!yes && !no) return null;
    return { output: { [key]: type === "boolean" ? yes : yes ? 1 : 0 } };
  }
  return null;
}

/**
 * Recorded answers file (engine JSONL contract): one envelope per call_seq.
 * The scripted answers are used in order; after the script ends the last answer
 * repeats up to `maxCalls` so a scripted user never "runs out" mid-run.
 * @param {string} tool
 * @param {Record<string, any> | undefined} toolDef
 * @param {unknown[]} answers
 * @param {number} maxCalls
 */
export function recordedAnswerLines(tool, toolDef, answers, maxCalls) {
  const lines = [];
  const n = Math.max(answers.length, Number(maxCalls) || answers.length);
  for (let i = 0; i < n; i++) {
    const env = answerEnvelope(toolDef, answers[Math.min(i, answers.length - 1)]);
    if (!env) return null;
    lines.push(JSON.stringify({ tool, call_seq: i + 1, result: env }));
  }
  return lines.join("\n") + "\n";
}

/** @param {string} file */
function readAnswersFile(file) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    return text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }
  const raw = file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
  return Array.isArray(raw) ? raw : raw?.answers;
}

/**
 * Scripted answers for one user-channel tool, first match wins:
 *   1. manifest `user_channel.answers` — a file (string: for user.ask) or a
 *      `{ <tool>: <file> }` map; {task_dir}/{task_id} templates; .json/.yml list
 *      of answers or .jsonl of engine envelopes
 *   2. manifest `user_channel.recorded.<tool>` — inline list
 *   3. task.yml `user_sim.recorded.<tool>` — inline list; `user_sim.answers` → user.ask
 *   4. an existing recorded `user:` binding's answers file
 *   5. the legacy auto-checkpoint native the base deployment used (LEGACY_AUTO_SCRIPTS)
 * @returns {unknown[] | null}
 */
function scriptedAnswers(opts, cfg, ctx) {
  const tool = opts.tool;
  const fileSpec =
    typeof cfg?.answers === "string" ? (tool === "user.ask" ? cfg.answers : null) : cfg?.answers?.[tool];
  const fromCfg = resolveTaskTemplatePath(fileSpec, ctx);
  if (fromCfg) {
    if (!existsSync(fromCfg)) throw new Error(`user_channel.answers not found: ${fromCfg}`);
    return readAnswersFile(fromCfg);
  }
  if (Array.isArray(cfg?.recorded?.[tool])) return cfg.recorded[tool];
  const sim = opts.taskYml?.user_sim;
  if (Array.isArray(sim?.recorded?.[tool])) return sim.recorded[tool];
  if (tool === "user.ask" && Array.isArray(sim?.answers)) return sim.answers;
  if (opts.existing?.source === "recorded" && opts.existing.answers) {
    const existingFile = join(opts.baseDir, String(opts.existing.answers));
    if (existsSync(existingFile)) return readAnswersFile(existingFile);
  }
  const legacy = LEGACY_AUTO_SCRIPTS[String(opts.baseNative ?? "")];
  return legacy ? structuredClone(legacy) : null;
}

/**
 * Resolve the user-channel binding for one tool of one attempt and write the
 * files it names into `attemptDir`.
 * @param {{
 *   tool: string,
 *   toolDef?: Record<string, any>,
 *   userChannel: Record<string, any> | null | undefined,
 *   existing?: Record<string, any> | null,
 *   baseNative?: string | null,
 *   baseDir: string,
 *   mode: "recorded" | "live",
 *   taskYml: Record<string, any>,
 *   taskAbsDir: string,
 *   taskId: string,
 *   attemptDir: string,
 *   maxCalls?: number,
 *   root?: string,
 * }} opts
 * @returns {{ spec: Record<string, any> | null, reason?: string, answers?: number }}
 */
export function resolveUserChannel(opts) {
  const cfg = opts.userChannel ?? null;
  const ctx = { taskAbsDir: opts.taskAbsDir, taskId: opts.taskId, root: opts.root };
  const safeTool = opts.tool.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const requested = cfg?.source ?? opts.existing?.source ?? "recorded";
  if (!USER_CHANNEL_SOURCES.has(String(requested))) {
    throw new Error(`user_channel.source must be recorded|simulator|human (got ${requested})`);
  }
  // Recorded runs never reach a live simulator or a human.
  const source = opts.mode === "recorded" ? "recorded" : String(requested);
  mkdirSync(opts.attemptDir, { recursive: true });

  if (source === "recorded") {
    const answers = scriptedAnswers(opts, cfg, ctx);
    if (!Array.isArray(answers) || !answers.length) {
      return { spec: null, reason: "recorded user channel has no answers (unbound → deny)" };
    }
    // Pre-built engine lines ({tool, result}) pass through unchanged.
    const prebuilt = answers.every((a) => a && typeof a === "object" && "result" in a && "tool" in a);
    const body = prebuilt
      ? answers.map((a) => JSON.stringify(a)).join("\n") + "\n"
      : recordedAnswerLines(opts.tool, opts.toolDef, answers, opts.maxCalls ?? answers.length);
    if (!body) {
      return { spec: null, reason: `answers do not fit ${opts.tool}'s output schema (unbound → deny)` };
    }
    const file = `user-answers.${safeTool}.jsonl`;
    writeFileSync(join(opts.attemptDir, file), body);
    return { spec: { source: "recorded", answers: file }, answers: answers.length };
  }

  if (source === "simulator") {
    const model = cfg?.model ?? opts.existing?.model;
    if (!model) throw new Error("user_channel.source=simulator requires user_channel.model");
    /** @type {Record<string, any>} */
    const spec = { source: "simulator", model: String(model) };
    for (const [key, suffix] of [
      ["system_prompt_file", "system"],
      ["context_file", "context"],
    ]) {
      const src =
        resolveTaskTemplatePath(cfg?.[key], ctx) ??
        (opts.existing?.[key] ? join(opts.baseDir, String(opts.existing[key])) : null);
      if (src == null) continue;
      if (!existsSync(src)) throw new Error(`user_channel.${key} not found: ${src}`);
      const file = `user-sim.${safeTool}.${suffix}${extname(src) || ".md"}`;
      writeFileSync(join(opts.attemptDir, file), readFileSync(src));
      spec[key] = file;
    }
    for (const key of SIMULATOR_PASSTHROUGH) {
      const v = cfg?.[key] ?? opts.existing?.[key];
      if (v != null) spec[key] = v;
    }
    return { spec };
  }
  return { spec: { source: "human" } };
}

/**
 * Write the per-attempt deployment when the attempt has user-channel tools.
 * @param {{
 *   basePath: string, attemptDir: string, userChannel: Record<string, any> | null | undefined,
 *   mode: "recorded" | "live", taskYml: Record<string, any>, taskAbsDir: string, taskId: string,
 *   declaredUserTools?: string[], toolDefs?: Record<string, Record<string, any>>, maxCalls?: number,
 *   root?: string,
 * }} opts
 * @returns {{ path: string, sha256: string, user_channel: Record<string, any> | null, user_tools: string[] }}
 */
export function materializeAttemptDeployment(opts) {
  const root = opts.root ?? repoRoot;
  const baseAbs = resolveRepoPath(opts.basePath, root);
  const baseText = readFileSync(baseAbs, "utf8");
  const dep = YAML.parse(baseText);
  const tools = userChannelTools(dep, {
    declared: opts.declaredUserTools,
    explicit: opts.userChannel?.tools ?? null,
  });
  if (!tools.length) {
    return { path: baseAbs, sha256: sha256(baseText), user_channel: null, user_tools: [] };
  }
  dep.bindings = { ...(dep.bindings ?? {}) };
  /** @type {Record<string, any>} */
  const resolved = {};
  for (const tool of tools) {
    const existing = dep.bindings[tool]?.user ?? null;
    const r = resolveUserChannel({
      tool,
      toolDef: opts.toolDefs?.[tool],
      userChannel: opts.userChannel,
      existing,
      baseNative: dep.bindings[tool]?.native ?? null,
      baseDir: dirname(baseAbs),
      mode: opts.mode,
      taskYml: opts.taskYml,
      taskAbsDir: opts.taskAbsDir,
      taskId: opts.taskId,
      attemptDir: opts.attemptDir,
      maxCalls: opts.maxCalls,
      root,
    });
    if (r.spec) {
      dep.bindings[tool] = { user: r.spec }; // never both native and user
      resolved[tool] = { ...r.spec, ...(r.answers != null ? { scripted_answers: r.answers } : {}) };
    } else {
      delete dep.bindings[tool]; // D14: no binding → deny
      resolved[tool] = { unbound: true, reason: r.reason };
    }
  }
  const text = YAML.stringify(dep);
  mkdirSync(opts.attemptDir, { recursive: true });
  const out = join(opts.attemptDir, `deployment.${basename(baseAbs).replace(/\.ya?ml$/, "")}.yml`);
  writeFileSync(out, text);
  return { path: out, sha256: sha256(text), user_channel: resolved, user_tools: tools };
}
