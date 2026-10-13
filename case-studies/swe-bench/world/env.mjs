/**
 * Per-task SWE-bench environments without Docker or root.
 *
 * Mirrors the upstream SWE-bench (v4.1.0) "env image + instance image" recipe:
 *   1. testbed  = repo clone at base_commit (shared objects from live/cache/swe mirror)
 *   2. conda    = micromamba env with the spec's python (+ conda packages), conda-forge only
 *   3. packages = requirements.txt / environment.yml / cached upstream environment.yml
 *   4. pip_packages, pre_install (non-root lines only), install
 *   5. commit setup edits in the testbed (upstream "clean diff" commit) → env_head
 *
 * Every deviation from upstream is recorded in env.json (`deviations`, `skipped`,
 * `pip_failures`). An env is only trusted for grading after the grader self-test
 * (gold patch resolves, empty patch does not) passes — see eval.mjs / selftest.mjs.
 *
 * Location: $FAUSTH_SWE_ENV_ROOT (default ~/.cache/fausth/swe-env). Nothing is
 * written into live/cache except reads of the git mirrors.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SWE_WORLD_DIR = here;
export const REPO_ROOT = resolve(here, "../../..");
const require = createRequire(join(REPO_ROOT, "engines/ts/package.json"));
const { parse: parseYaml } = require("yaml");

/** Bump to invalidate every built env when the build recipe changes. */
export const ENV_BUILD_VERSION = 2;

export const MICROMAMBA = Object.freeze({
  version: "2.9.0",
  url: "https://micro.mamba.pm/api/micromamba/linux-64/2.9.0",
  sha256: "8761c382127e6363bd9e0a2451aa3ef90d071a79133f736e2f759a3bf13040dd",
});

export function envRoot() {
  return resolve(process.env.FAUSTH_SWE_ENV_ROOT || join(homedir(), ".cache", "fausth", "swe-env"));
}

export function toolsRoot() {
  return resolve(process.env.FAUSTH_TOOLS_ROOT || join(homedir(), ".cache", "fausth", "tools"));
}

export function envDirFor(instanceId) {
  if (!/^[A-Za-z0-9._-]+$/.test(instanceId)) throw new Error(`bad instance id: ${instanceId}`);
  return join(envRoot(), instanceId);
}

let specsCache = null;
export function loadUpstreamSpecs() {
  if (!specsCache) {
    specsCache = JSON.parse(readFileSync(join(here, "upstream-specs.json"), "utf8"));
  }
  return specsCache;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Load a SWE task (task.yml + oracle patches) and verify oracle integrity
 * against the hashes recorded at import time.
 * @param {string} taskAbsDir
 */
export function loadSweTask(taskAbsDir) {
  const yml = parseYaml(readFileSync(join(taskAbsDir, "task.yml"), "utf8"));
  const grade = yml.grade ?? {};
  const testPatchPath = join(taskAbsDir, "oracle", "test_patch.diff");
  const goldPatchPath = join(taskAbsDir, "oracle", "patch.diff");
  const testPatch = existsSync(testPatchPath) ? readFileSync(testPatchPath, "utf8") : null;
  const goldPatch = existsSync(goldPatchPath) ? readFileSync(goldPatchPath, "utf8") : null;
  const integrity = [];
  if (testPatch != null && yml.gold?.test_patch_sha256 && sha256(testPatch) !== yml.gold.test_patch_sha256) {
    integrity.push("oracle/test_patch.diff sha256 mismatch vs task.yml gold.test_patch_sha256");
  }
  if (goldPatch != null && yml.gold?.patch_sha256 && sha256(goldPatch) !== yml.gold.patch_sha256) {
    integrity.push("oracle/patch.diff sha256 mismatch vs task.yml gold.patch_sha256");
  }
  return {
    id: String(yml.id ?? yml.source?.instance_id),
    repo: String(yml.repo),
    version: String(yml.version),
    base_commit: String(yml.base_commit ?? yml.seed?.base_commit),
    environment_setup_commit: String(yml.environment_setup_commit ?? yml.base_commit),
    FAIL_TO_PASS: grade.FAIL_TO_PASS ?? yml.FAIL_TO_PASS,
    PASS_TO_PASS: grade.PASS_TO_PASS ?? yml.PASS_TO_PASS,
    test_patch: testPatch,
    gold_patch: goldPatch,
    integrity_errors: integrity,
    taskAbsDir,
  };
}

/** Repos whose install step compiles extensions (re-install needed after edits). */
export const COMPILED_REPOS = new Set([
  "astropy/astropy",
  "matplotlib/matplotlib",
  "scikit-learn/scikit-learn",
]);

/**
 * Local deviations from the upstream recipe, applied on top of the pinned
 * upstream spec. Every entry is recorded in env.json.
 */
const LOCAL_DEVIATIONS = [
  {
    match: () => true,
    note: "conda-forge only (no Anaconda 'defaults' channel); cached upstream environment.yml build strings dropped",
  },
  {
    match: () => true,
    note: "pre_install lines needing root (apt-get, /etc, locale-gen) are skipped; locale via LANG/LC_ALL env vars",
  },
  {
    match: () => true,
    note: "setuptools pinned to 69.5.1 at env creation for python>=3.8 (date-matched to the 2024 upstream images; setuptools>=81 breaks pkg_resources-based tests); spec pip pins still win",
  },
  {
    match: (t) => t.repo === "matplotlib/matplotlib",
    note: "apt libfreetype6-dev/pkg-config replaced by conda-forge freetype + pkg-config; texlive/ffmpeg/imagemagick unavailable (tests needing them skip)",
    extraConda: ["freetype", "pkg-config"],
  },
  {
    match: (t) => t.repo === "matplotlib/matplotlib" && t.version === "3.5",
    note: "vcs-versioning (2026 split of setuptools_scm, pulled in by today's conda-forge setuptools_scm) is uninstalled: it re-registers version schemes with DeprecationWarnings that the pinned setuptools-scm==7.1.0 era never had",
    postUninstall: ["vcs-versioning"],
  },
];

/**
 * Upstream spec for a task + local deviations.
 * @param {{ repo: string, version: string, id: string }} task
 */
export function specFor(task) {
  const specs = loadUpstreamSpecs();
  const byRepo = specs.specs[task.repo];
  if (!byRepo) throw new Error(`no upstream spec for repo ${task.repo}`);
  const upstream = byRepo[task.version];
  if (!upstream) throw new Error(`no upstream spec for ${task.repo}@${task.version}`);
  const deviations = [];
  const extraConda = [];
  const postUninstall = [];
  for (const d of LOCAL_DEVIATIONS) {
    if (!d.match(task)) continue;
    deviations.push(d.note);
    if (d.extraConda) extraConda.push(...d.extraConda);
    if (d.postUninstall) postUninstall.push(...d.postUninstall);
  }
  const cachedYml = join(here, "envs", task.id, "environment.yml");
  return {
    upstream,
    deviations,
    extraConda,
    postUninstall,
    cachedEnvYml: existsSync(cachedYml) ? cachedYml : null,
    reqsPaths: specs.reqs_paths[task.repo] ?? [],
    envYmlPaths: specs.env_yml_paths[task.repo] ?? [],
  };
}

export function mirrorPath(repo) {
  const slug = repo.replace(/[^a-zA-Z0-9._-]+/g, "__");
  return join(REPO_ROOT, "live", "cache", "swe", `${slug}.git`);
}

export function envFingerprint(task, spec) {
  const sysLibs = spec.cachedEnvYml ? cachedSystemLibs(readFileSync(spec.cachedEnvYml, "utf8")) : [];
  return sha256(
    JSON.stringify({
      v: ENV_BUILD_VERSION,
      repo: task.repo,
      version: task.version,
      base: task.base_commit,
      env_commit: task.environment_setup_commit,
      upstream: spec.upstream,
      deviations: spec.deviations,
      extraConda: spec.extraConda,
      cached: spec.cachedEnvYml ? sha256(readFileSync(spec.cachedEnvYml, "utf8")) : null,
      ...(sysLibs.length ? { sysLibs } : {}),
    }),
  );
}

export function loadEnvRecord(instanceId) {
  const p = join(envDirFor(instanceId), "env.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * Cross-process directory lock (mkdir is atomic). Stale locks of dead pids are broken.
 * @template T
 * @param {string} lockDir
 * @param {number} timeoutMs
 * @param {() => T} fn
 * @returns {T}
 */
export function withDirLock(lockDir, timeoutMs, fn) {
  mkdirSync(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
        stale = !pidAlive(Number(owner.pid));
      } catch {
        // owner.json not written yet (race) or unreadable: treat as stale only if old
        try {
          stale = Date.now() - statSync(lockDir).mtimeMs > 60_000;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lockDir}`);
      sleepMs(500);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Minimal, secret-free environment for builds and test runs. */
export function cleanEnv(extra = {}) {
  const keep = ["PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM"];
  /** @type {Record<string,string>} */
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = String(process.env[k]);
  env.HOME = process.env.HOME || homedir();
  env.LANG = "en_US.UTF-8";
  env.LC_ALL = "en_US.UTF-8";
  env.LANGUAGE = "en_US:en";
  env.PYTHONIOENCODING = "utf8";
  env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  env.PIP_NO_INPUT = "1";
  return { ...env, ...extra };
}

export function condaEnv(record, extra = {}) {
  const base = cleanEnv(extra);
  return {
    ...base,
    PATH: `${join(record.conda_prefix, "bin")}:${base.PATH ?? "/usr/bin:/bin"}`,
    CONDA_PREFIX: record.conda_prefix,
    ...extra,
  };
}

/**
 * Run a bash script, appending combined output to a log file.
 * @returns {{ code: number, output: string, timedOut: boolean }}
 */
export function runBash(script, { cwd, env, timeoutMs = 3600_000, logFile = null, label = "" } = {}) {
  const res = spawnSync("bash", ["-c", `exec 2>&1\n${script}`], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const timedOut = res.error?.code === "ETIMEDOUT" || res.signal === "SIGKILL";
  const code = typeof res.status === "number" ? res.status : timedOut ? 124 : 1;
  if (logFile) {
    appendFileSync(
      logFile,
      `\n===== ${label || "bash"} (exit ${code}${timedOut ? ", TIMEOUT" : ""}) @ ${new Date().toISOString()}\n$ ${script}\n${output}\n`,
    );
  }
  return { code, output, timedOut };
}

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

/** Download + verify the pinned micromamba binary (no root, no conda install). */
export function ensureMicromamba(logFile = null) {
  const override = process.env.FAUSTH_MICROMAMBA;
  if (override) return override;
  const dir = join(toolsRoot(), "micromamba");
  const bin = join(dir, "bin", "micromamba");
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, `micromamba-${MICROMAMBA.version}.tar.bz2`);
  const r = runBash(
    `curl -fsSL -o ${q(tarball)} ${q(MICROMAMBA.url)} && echo "${MICROMAMBA.sha256}  ${tarball}" | sha256sum -c - && tar -xjf ${q(tarball)} -C ${q(dir)} bin/micromamba`,
    { env: cleanEnv(), timeoutMs: 600_000, logFile, label: "micromamba download" },
  );
  if (r.code !== 0 || !existsSync(bin)) {
    throw new StepError("micromamba", `micromamba download/verify failed: ${r.output.slice(-2000)}`);
  }
  return bin;
}

/** `git show <commit>:<path>` from the mirror (null when absent). */
function gitShow(mirror, commit, path) {
  const r = spawnSync("git", ["--git-dir", mirror, "show", `${commit}:${path}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

/** upstream get_requirements_by_commit + clean_requirements, reading from the git mirror. */
export function requirementsFromMirror(mirror, commit, reqsPaths) {
  for (const reqPath of reqsPaths) {
    const text = gitShow(mirror, commit, reqPath);
    if (text == null) continue;
    const reqDir = reqPath.split("/").slice(0, -1).join("/");
    const exclude = (line) => ["-e .", "#", ".[test"].some((x) => line.trim().startsWith(x));
    const original = [];
    const additional = [];
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("-r")) {
        const fileName = line.trim().slice(2).trim();
        const sub = gitShow(mirror, commit, reqDir ? `${reqDir}/${fileName}` : fileName);
        if (sub != null) for (const l of sub.split("\n")) if (!exclude(l)) additional.push(l);
      } else if (!exclude(line)) {
        original.push(line);
      }
    }
    additional.push(original.join("\n"));
    let all = additional.join("\n");
    all = all.replace(/^types-pkg_resources([<>=!~]=?.*|$)/gm, "types-setuptools");
    return { path: reqPath, text: all };
  }
  return null;
}

const CONDA_TO_PIP = {
  "msgpack-python": "msgpack",
  "brotli-python": "brotli",
  "matplotlib-base": "matplotlib",
  pytables: "tables",
  "typing_extensions": "typing-extensions",
  "importlib_metadata": "importlib-metadata",
};
/**
 * Non-python conda packages that pip-installed bindings need at runtime (e.g.
 * cfgrib → eccodes). For cached upstream lockfiles they are conda-installed at
 * the lockfile version; everything else non-python comes from wheels.
 */
const CONDA_SYSTEM_LIBS = new Set(["eccodes", "hdf5", "libnetcdf", "proj", "geos", "udunits2"]);

/** System-library conda specs (name=version) a cached lockfile needs. */
export function cachedSystemLibs(text) {
  const doc = parseYaml(text) ?? {};
  const out = [];
  for (const d of Array.isArray(doc.dependencies) ? doc.dependencies : []) {
    if (typeof d !== "string") continue;
    const m = /^([^=<>!~ ]+)=([^=<>!~ ]+)(?:=[^=<>!~ ]+)?$/.exec(d.trim());
    if (m && CONDA_SYSTEM_LIBS.has(m[1])) out.push(`${m[1]}=${m[2]}`);
  }
  return out;
}

const CONDA_PY_SKIP = new Set([
  "python",
  "pip",
  "setuptools",
  "wheel",
  "python_abi",
  "pyqt",
  "pyqt5-sip",
  "sip",
  "qt",
  "conda",
]);

/**
 * Split a conda environment.yml into conda specs (no build strings) and pip lines.
 * With `pythonLibsAsPip`, python libraries pinned by build string (py36h…, pyh…)
 * are returned as pip pins instead (used for cached upstream lockfiles).
 */
export function splitEnvYml(text, { pythonLibsAsPip = false } = {}) {
  const doc = parseYaml(text) ?? {};
  const deps = Array.isArray(doc.dependencies) ? doc.dependencies : [];
  const conda = [];
  const pip = [];
  let python = null;
  for (const d of deps) {
    if (d && typeof d === "object" && Array.isArray(d.pip)) {
      for (const p of d.pip) pip.push(String(p));
      continue;
    }
    if (typeof d !== "string") continue;
    const spec = d.trim();
    const name = spec.split(/[=<>!~ ]/)[0].trim();
    // Exact lockfile form name=version=build (single '=' separators only).
    const lock = /^([^=<>!~ ]+)=([^=<>!~ ]+)=([^=<>!~ ]+)$/.exec(spec);
    const simple = /^([^=<>!~ ]+)=([^=<>!~ ]+)$/.exec(spec);
    const version = lock ? lock[2] : simple ? simple[2] : "";
    const build = lock ? lock[3] : "";
    if (name === "python") {
      python = version || null;
      continue;
    }
    if (pythonLibsAsPip) {
      const isPyLib = /^py(\d|h|_)/.test(build);
      if (!isPyLib || CONDA_PY_SKIP.has(name)) continue;
      const pipName = CONDA_TO_PIP[name] ?? name;
      pip.push(version ? `${pipName}==${version}` : pipName);
    } else {
      if (name === "pip") continue;
      // conda `name=1.2` means 1.2.* and is kept verbatim; lockfile build strings are dropped.
      conda.push(lock ? `${lock[1]}=${lock[2]}` : spec);
    }
  }
  return { python, conda, pip };
}

/**
 * pip install with an individual-package fallback (records failures instead of
 * aborting, so the self-test — not a guess — decides whether the env is usable).
 */
function pipInstall(ctx, pkgs, label) {
  const list = pkgs.map((p) => p.trim()).filter((p) => p && !p.startsWith("#"));
  if (!list.length) return;
  const env = condaEnv(ctx.recordish);
  const bulk = runBash(`python -m pip install ${list.map(q).join(" ")}`, {
    cwd: ctx.testbed,
    env,
    logFile: ctx.logFile,
    label: `${label} (bulk)`,
  });
  if (bulk.code === 0) return;
  for (const p of list) {
    const one = runBash(`python -m pip install ${q(p)}`, {
      cwd: ctx.testbed,
      env,
      logFile: ctx.logFile,
      label: `${label}: ${p}`,
    });
    if (one.code !== 0) ctx.pipFailures.push({ step: label, package: p });
  }
}

function requirementLines(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
}

/**
 * Build (or reuse) the environment for a task. Synchronous; serialised per task
 * by a directory lock. Returns the env record (ok=false on failure).
 * @param {ReturnType<typeof loadSweTask>} task
 * @param {{ force?: boolean, log?: (s: string) => void }} [opts]
 */
export function buildEnv(task, opts = {}) {
  const log = opts.log ?? (() => {});
  const spec = specFor(task);
  const dir = envDirFor(task.id);
  const fp = envFingerprint(task, spec);
  mkdirSync(envRoot(), { recursive: true });
  return withDirLock(join(envRoot(), ".locks", `${task.id}.build`), 6 * 3600_000, () => {
    const existing = loadEnvRecord(task.id);
    if (!opts.force && existing && existing.fingerprint === fp) return existing;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const started = Date.now();
    const ctx = {
      task,
      spec,
      dir,
      testbed: join(dir, "testbed"),
      conda: join(dir, "conda"),
      logFile: join(dir, "build.log"),
      pipFailures: /** @type {{step:string,package:string}[]} */ ([]),
      skipped: /** @type {string[]} */ ([]),
      recordish: { conda_prefix: join(dir, "conda") },
    };
    writeFileSync(ctx.logFile, `fausth swe env build ${task.id} (${task.repo}@${task.version})\n`);
    /** @type {Record<string, unknown>} */
    let record;
    try {
      const mirror = mirrorPath(task.repo);
      if (!existsSync(mirror)) throw new StepError("mirror", `missing git mirror ${mirror}`);
      log(`[env ${task.id}] testbed`);
      let r = runBash(
        `git clone -q --shared --no-checkout ${q(mirror)} ${q(ctx.testbed)} && git -C ${q(ctx.testbed)} -c advice.detachedHead=false checkout -q -f ${q(task.base_commit)}`,
        { env: cleanEnv(), logFile: ctx.logFile, label: "testbed" },
      );
      if (r.code !== 0) throw new StepError("testbed", r.output.slice(-2000));

      const up = spec.upstream;
      const mm = ensureMicromamba(ctx.logFile);
      const mmEnv = cleanEnv({ MAMBA_ROOT_PREFIX: join(toolsRoot(), "mamba-root") });
      /** @type {string[]} */
      let condaPkgs = [];
      let pythonVersion = String(up.python);
      /** @type {string[]} */
      let pipFromYml = [];
      /** @type {string[]} */
      let condaFromYml = [];
      if (spec.cachedEnvYml) {
        const ymlText = readFileSync(spec.cachedEnvYml, "utf8");
        const split = splitEnvYml(ymlText, { pythonLibsAsPip: true });
        if (split.python) pythonVersion = split.python;
        pipFromYml = split.pip;
        condaFromYml = cachedSystemLibs(ymlText);
      } else if (up.packages === "environment.yml") {
        let ymlText = null;
        for (const p of spec.envYmlPaths) {
          ymlText = gitShow(mirror, task.environment_setup_commit, p);
          if (ymlText != null) break;
        }
        if (ymlText == null) throw new StepError("environment.yml", "environment.yml not found at env commit");
        const split = splitEnvYml(ymlText);
        condaFromYml = split.conda;
        pipFromYml = split.pip;
      } else if (up.packages && up.packages !== "requirements.txt") {
        condaPkgs = String(up.packages)
          .split(/\s+/)
          .map((s) => s.replace(/^'|'$/g, "").replace("==", "="))
          .filter(Boolean);
      }
      log(`[env ${task.id}] conda python=${pythonVersion}`);
      const [pyMaj, pyMin] = pythonVersion.split(".").map(Number);
      const setuptoolsPin = pyMaj > 3 || (pyMaj === 3 && pyMin >= 8) ? ["setuptools=69.5.1"] : [];
      r = runBash(
        `${q(mm)} create -y -q -p ${q(ctx.conda)} -c conda-forge --override-channels ${q(`python=${pythonVersion}`)} pip ${[...setuptoolsPin, ...condaPkgs, ...spec.extraConda].map(q).join(" ")}`,
        { env: mmEnv, logFile: ctx.logFile, label: "conda create", timeoutMs: 3600_000 },
      );
      if (r.code !== 0) throw new StepError("conda", r.output.slice(-3000));
      if (condaFromYml.length) {
        r = runBash(
          `${q(mm)} install -y -q -p ${q(ctx.conda)} -c conda-forge --override-channels ${condaFromYml.map(q).join(" ")}`,
          { env: mmEnv, logFile: ctx.logFile, label: "conda install environment.yml deps", timeoutMs: 3600_000 },
        );
        if (r.code !== 0) {
          for (const pkg of condaFromYml) {
            const one = runBash(
              `${q(mm)} install -y -q -p ${q(ctx.conda)} -c conda-forge --override-channels ${q(pkg)}`,
              { env: mmEnv, logFile: ctx.logFile, label: `conda install ${pkg}`, timeoutMs: 1800_000 },
            );
            if (one.code !== 0) ctx.pipFailures.push({ step: "conda environment.yml", package: pkg });
          }
        }
      }

      if (up.packages === "requirements.txt") {
        const reqs = requirementsFromMirror(mirror, task.environment_setup_commit, spec.reqsPaths);
        if (!reqs) throw new StepError("requirements", "requirements file not found at env commit");
        const reqFile = join(dir, "requirements.txt");
        writeFileSync(reqFile, reqs.text + "\n");
        log(`[env ${task.id}] pip -r ${reqs.path}`);
        const bulk = runBash(`python -m pip install -r ${q(reqFile)}`, {
          cwd: ctx.testbed,
          env: condaEnv(ctx.recordish),
          logFile: ctx.logFile,
          label: "pip install -r requirements",
        });
        if (bulk.code !== 0) pipInstall(ctx, requirementLines(reqs.text), "requirements.txt");
      }
      if (pipFromYml.length) {
        log(`[env ${task.id}] pip (environment.yml) ${pipFromYml.length} pkgs`);
        pipInstall(ctx, pipFromYml, "environment.yml pip");
      }
      if (Array.isArray(up.pip_packages) && up.pip_packages.length) {
        log(`[env ${task.id}] pip_packages`);
        pipInstall(ctx, up.pip_packages, "pip_packages");
      }

      if (spec.postUninstall.length) {
        runBash(`python -m pip uninstall -y ${spec.postUninstall.map(q).join(" ")}`, {
          cwd: ctx.testbed,
          env: condaEnv(ctx.recordish),
          logFile: ctx.logFile,
          label: "post-uninstall (deviation)",
        });
      }

      const pre = Array.isArray(up.pre_install) ? up.pre_install : [];
      const runnable = [];
      for (const line of pre) {
        if (/apt-get|locale-gen|\/etc\//.test(line)) {
          ctx.skipped.push(`pre_install: ${line}`);
          continue;
        }
        runnable.push(line.replaceAll("/testbed", ctx.testbed));
      }
      if (runnable.length) {
        log(`[env ${task.id}] pre_install`);
        r = runBash(`set -e\n${runnable.join("\n")}`, {
          cwd: ctx.testbed,
          env: condaEnv(ctx.recordish),
          logFile: ctx.logFile,
          label: "pre_install",
        });
        if (r.code !== 0) throw new StepError("pre_install", r.output.slice(-3000));
      }

      if (up.install) {
        log(`[env ${task.id}] install: ${up.install}`);
        r = runBash(up.install, {
          cwd: ctx.testbed,
          env: condaEnv(ctx.recordish),
          logFile: ctx.logFile,
          label: "install",
          timeoutMs: 3600_000,
        });
        if (r.code !== 0) throw new StepError("install", r.output.slice(-3000));
      }

      r = runBash(
        `git -c user.email=env@fausth.local -c user.name=fausth-env commit -q --allow-empty -am "fausth env setup" && git rev-parse HEAD`,
        { cwd: ctx.testbed, env: cleanEnv(), logFile: ctx.logFile, label: "commit setup" },
      );
      if (r.code !== 0) throw new StepError("commit", r.output.slice(-2000));
      const envHead = r.output.trim().split("\n").pop()?.trim();

      const pyv = runBash(`python -c "import sys; print(sys.version.split()[0])"`, {
        cwd: ctx.testbed,
        env: condaEnv(ctx.recordish),
      });
      runBash(`python -m pip freeze > ${q(join(dir, "pip-freeze.txt"))}`, {
        cwd: ctx.testbed,
        env: condaEnv(ctx.recordish),
      });
      record = {
        ok: true,
        instance_id: task.id,
        repo: task.repo,
        version: task.version,
        fingerprint: fp,
        env_build_version: ENV_BUILD_VERSION,
        python: pyv.output.trim(),
        python_spec: String(up.python),
        conda_prefix: ctx.conda,
        testbed: ctx.testbed,
        base_commit: task.base_commit,
        env_head: envHead,
        cached_env_yml: spec.cachedEnvYml ? spec.cachedEnvYml.slice(REPO_ROOT.length + 1) : null,
        deviations: spec.deviations,
        skipped: ctx.skipped,
        pip_failures: ctx.pipFailures,
        built_at: new Date().toISOString(),
        build_seconds: Math.round((Date.now() - started) / 1000),
        build_log: ctx.logFile,
      };
    } catch (e) {
      record = {
        ok: false,
        instance_id: task.id,
        repo: task.repo,
        version: task.version,
        fingerprint: fp,
        env_build_version: ENV_BUILD_VERSION,
        failed_step: e instanceof StepError ? e.step : "unknown",
        error: String(e?.message ?? e).slice(-4000),
        deviations: spec.deviations,
        skipped: ctx.skipped,
        pip_failures: ctx.pipFailures,
        built_at: new Date().toISOString(),
        build_seconds: Math.round((Date.now() - started) / 1000),
        build_log: ctx.logFile,
      };
    }
    writeFileSync(join(dir, "env.json"), JSON.stringify(record, null, 2) + "\n");
    return record;
  });
}
