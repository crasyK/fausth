/**
 * Deployment materialization for case-study runs.
 *
 * - KIT model variants (SCR-4): derived from the manifest's kit template,
 *   content-hash named, regenerated on every start (incl. --resume). Only
 *   commands whose argv[0] is literally `pytest` are re-pointed at the repo's
 *   pytest resolver; every other command (e.g. `node --test`) is untouched.
 * - User channel (D14): when the manifest declares `user_channel`, tools on the
 *   user channel are bound with the canonical form
 *   `bindings.<tool> = { user: { source, answers?, model?, system_prompt_file?, context_file? } }`.
 *   Recorded mode always binds `source: "recorded"` answers.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const require = createRequire(join(repoRoot, "engines/ts/package.json"));
const YAML = require("yaml");

/** Natives that implement the user question channel today. */
const USER_ASK_NATIVES = new Set(["local.user_ask", "local.user_ask_auto"]);
export const USER_CHANNEL_SOURCES = new Set(["recorded", "simulator", "human"]);

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
  if (Array.isArray(opts.explicit) && opts.explicit.length) return [...new Set(opts.explicit)];
  const tools = new Set(opts.declared ?? []);
  for (const [tool, binding] of Object.entries(dep.bindings ?? {})) {
    if (binding && typeof binding === "object") {
      if (USER_ASK_NATIVES.has(String(binding.native ?? ""))) tools.add(tool);
      if (binding.user && typeof binding.user === "object") tools.add(tool);
    }
  }
  return [...tools].sort();
}

/**
 * Tool ids a harness declares on the user channel (`channel: user`).
 * @param {string} harnessDir
 */
export function declaredUserChannelTools(harnessDir) {
  for (const name of ["agent.json", "agent.yml"]) {
    const p = join(harnessDir, name);
    if (!existsSync(p)) continue;
    try {
      const doc = name.endsWith(".json")
        ? JSON.parse(readFileSync(p, "utf8"))
        : YAML.parse(readFileSync(p, "utf8"));
      return (doc?.tools ?? [])
        .filter((t) => t && (t.channel === "user" || t.channel?.kind === "user"))
        .map((t) => String(t.id));
    } catch {
      return [];
    }
  }
  return [];
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
 * Resolve the manifest `user_channel` config for one attempt.
 * @param {{
 *   userChannel: Record<string, any> | null | undefined,
 *   mode: "recorded" | "live",
 *   taskYml: Record<string, any>,
 *   taskAbsDir: string,
 *   taskId: string,
 *   attemptDir: string,
 *   root?: string,
 * }} opts
 * @returns {{ spec: Record<string, any> | null, answers: string[] | null, reason?: string }}
 */
export function resolveUserChannel(opts) {
  const cfg = opts.userChannel;
  if (!cfg) return { spec: null, answers: null, reason: "no user_channel in manifest" };
  const source = opts.mode === "recorded" ? "recorded" : String(cfg.source ?? "");
  if (!USER_CHANNEL_SOURCES.has(source)) {
    throw new Error(`user_channel.source must be recorded|simulator|human (got ${cfg.source})`);
  }
  const ctx = { taskAbsDir: opts.taskAbsDir, taskId: opts.taskId, root: opts.root };
  if (source === "recorded") {
    let answers = null;
    const answersPath = resolveTaskTemplatePath(cfg.answers, ctx);
    if (answersPath) {
      if (!existsSync(answersPath)) throw new Error(`user_channel.answers not found: ${answersPath}`);
      const raw = answersPath.endsWith(".json")
        ? JSON.parse(readFileSync(answersPath, "utf8"))
        : YAML.parse(readFileSync(answersPath, "utf8"));
      answers = Array.isArray(raw) ? raw : raw?.answers;
    } else if (Array.isArray(opts.taskYml?.user_sim?.answers)) {
      answers = opts.taskYml.user_sim.answers;
    }
    if (!Array.isArray(answers) || !answers.length) {
      return { spec: null, answers: null, reason: "recorded user channel has no answers (unbound → deny)" };
    }
    const list = answers.map((a) => String(a));
    const file = join(opts.attemptDir, "user-answers.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
    return { spec: { source: "recorded", answers: file }, answers: list };
  }
  if (source === "simulator") {
    if (!cfg.model) throw new Error("user_channel.source=simulator requires user_channel.model");
    /** @type {Record<string, any>} */
    const spec = { source: "simulator", model: String(cfg.model) };
    for (const key of ["system_prompt_file", "context_file"]) {
      const p = resolveTaskTemplatePath(cfg[key], ctx);
      if (p == null) continue;
      if (!existsSync(p)) throw new Error(`user_channel.${key} not found: ${p}`);
      spec[key] = p;
    }
    return { spec, answers: null };
  }
  return { spec: { source: "human" }, answers: null };
}

/**
 * Write the per-attempt deployment (only when the user channel changes bindings).
 * @param {{
 *   basePath: string, attemptDir: string, userChannel: Record<string, any> | null | undefined,
 *   mode: "recorded" | "live", taskYml: Record<string, any>, taskAbsDir: string, taskId: string,
 *   declaredUserTools?: string[], root?: string,
 * }} opts
 * @returns {{ path: string, sha256: string, user_channel: Record<string, any> | null, user_tools: string[] }}
 */
export function materializeAttemptDeployment(opts) {
  const root = opts.root ?? repoRoot;
  const baseAbs = resolveRepoPath(opts.basePath, root);
  const baseText = readFileSync(baseAbs, "utf8");
  if (!opts.userChannel) {
    return { path: baseAbs, sha256: sha256(baseText), user_channel: null, user_tools: [] };
  }
  const dep = YAML.parse(baseText);
  const tools = userChannelTools(dep, {
    declared: opts.declaredUserTools,
    explicit: opts.userChannel.tools ?? null,
  });
  const resolved = resolveUserChannel({
    userChannel: opts.userChannel,
    mode: opts.mode,
    taskYml: opts.taskYml,
    taskAbsDir: opts.taskAbsDir,
    taskId: opts.taskId,
    attemptDir: opts.attemptDir,
    root,
  });
  dep.bindings = { ...(dep.bindings ?? {}) };
  for (const tool of tools) {
    if (resolved.spec) dep.bindings[tool] = { user: resolved.spec };
    else delete dep.bindings[tool]; // D14: no binding → deny
  }
  const text = YAML.stringify(dep);
  mkdirSync(opts.attemptDir, { recursive: true });
  const out = join(opts.attemptDir, `deployment.${basename(baseAbs).replace(/\.ya?ml$/, "")}.yml`);
  writeFileSync(out, text);
  return {
    path: out,
    sha256: sha256(text),
    user_channel: resolved.spec ? { ...resolved.spec, tools } : { unbound: tools, reason: resolved.reason },
    user_tools: tools,
  };
}
