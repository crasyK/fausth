/**
 * Shared helpers for host child processes (local world commands, MCP/module stdio servers).
 *
 * - Environment allowlist (EDGE-4/EDGE-9): children never inherit the host environment
 *   wholesale; secret-looking variables (API keys, tokens, ...) are never passed, even when
 *   a deployment asks for them by name.
 * - Captured runs (EDGE-18): stream + bound stdout/stderr, report the true exit code,
 *   kill the whole process group on timeout.
 * - Secret redaction for world observations (D13).
 */
import { spawn } from "node:child_process";

/** Env var names that must never be forwarded to a child process. */
export const SECRET_ENV_NAME_RE =
  /(api[_-]?key|access[_-]?key|secret|password|passwd|token|credential|authorization|private[_-]?key|cookie|session)/i;

/** Non-secret variables a child may inherit from the host by default. */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Windows essentials (no-ops elsewhere)
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
];

export class ChildEnvError extends Error {
  readonly code = "secret_env_forbidden" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChildEnvError";
  }
}

/** Throw when a declared env name looks like a secret. */
export function assertNoSecretEnvNames(names: Iterable<string>, label: string): void {
  for (const k of names) {
    if (SECRET_ENV_NAME_RE.test(k)) {
      throw new ChildEnvError(`forbidden secret-like ${label} env key '${k}'`);
    }
  }
}

export type ChildEnvOptions = {
  /** Extra host variable names to pass through (non-secret names only). */
  passthrough?: readonly string[];
  /** Literal values to set (non-secret names only). */
  set?: Record<string, string>;
  /** HOME for the child (e.g. a private temp dir). Omit to leave HOME unset. */
  home?: string;
  /** Source environment (defaults to process.env). */
  source?: NodeJS.ProcessEnv;
};

/** Build a minimal child environment from an allowlist (never `{...process.env}`). */
export function buildChildEnv(opts: ChildEnvOptions = {}, label = "child"): Record<string, string> {
  const source = opts.source ?? process.env;
  const passthrough = [...(opts.passthrough ?? [])];
  const set = opts.set ?? {};
  assertNoSecretEnvNames(passthrough, label);
  assertNoSecretEnvNames(Object.keys(set), label);
  const out: Record<string, string> = {};
  for (const name of [...BASE_ENV_ALLOWLIST, ...passthrough]) {
    const v = source[name];
    if (typeof v === "string") out[name] = v;
  }
  for (const [k, v] of Object.entries(set)) {
    if (typeof v !== "string") {
      throw new ChildEnvError(`${label} env value for '${k}' must be a string`);
    }
    out[k] = v;
  }
  if (opts.home) {
    out.HOME = opts.home;
    out.USERPROFILE = opts.home;
    out.XDG_CONFIG_HOME = `${opts.home}/.config`;
    out.XDG_CACHE_HOME = `${opts.home}/.cache`;
    out.XDG_DATA_HOME = `${opts.home}/.local/share`;
  }
  // Keep git from reading the operator's global/system config (credential helpers, hooksPath, ...).
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

/** Values of host env vars whose names look secret (≥ 8 chars) — used for redaction. */
export function hostSecretValues(source: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string" && v.length >= 8 && SECRET_ENV_NAME_RE.test(k)) out.push(v);
  }
  return out;
}

/** High-signal token shapes redacted from world observations even when not labeled. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:or-|proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
];

export const REDACTED = "[REDACTED]";

/**
 * Replace every occurrence of a known secret value and every high-signal token shape.
 * Longer values are replaced first so overlapping secrets cannot leave fragments.
 */
export function redactSecrets(text: string, values: Iterable<string> = []): string {
  let out = text;
  const vals = [...new Set([...values].map((v) => String(v)).filter((v) => v.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  for (const v of vals) {
    if (out.includes(v)) out = out.split(v).join(REDACTED);
  }
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** First `max` code points of `s` (D2: truncation counts code points). */
export function truncateCodePoints(s: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: "", truncated: s.length > 0 };
  let count = 0;
  let idx = 0;
  while (idx < s.length) {
    if (count === max) return { text: s.slice(0, idx), truncated: true };
    const cp = s.codePointAt(idx)!;
    idx += cp > 0xffff ? 2 : 1;
    count += 1;
  }
  return { text: s, truncated: false };
}

export type CapturedRun = {
  /** Real exit code; 124 on timeout, 127 when the binary could not be spawned, 128+n on signal. */
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  /** True when the stream produced more bytes than were captured. */
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
  /** Spawn failure code (e.g. ENOENT) when the process never started. */
  spawnError?: string;
};

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run argv without a shell, streaming output into bounded buffers. Never rejects:
 * spawn failures are reported via `spawnError` + exit code 127.
 */
export function runCommandCaptured(
  bin: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    /** Bytes captured per stream (output beyond this is drained and counted as overflow). */
    captureBytes: number;
  },
): Promise<CapturedRun> {
  return new Promise((resolvePromise) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (r: Omit<CapturedRun, "stdout" | "stderr" | "stdoutOverflow" | "stderrOverflow">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      resolvePromise({
        ...r,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        stdoutOverflow,
        stderrOverflow,
      });
    };
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child?.pid, "SIGTERM");
      setTimeout(() => killTree(child?.pid, "SIGKILL"), 500).unref();
      // A grandchild that escaped the process group may keep pipes open: stop waiting.
      hardStop = setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        finish({ exitCode: 124, timedOut: true, signal: "SIGKILL" });
      }, 2000);
      hardStop.unref();
    }, Math.max(1, opts.timeoutMs));
    try {
      child = spawn(bin, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "spawn_failed";
      finish({ exitCode: 127, timedOut: false, signal: null, spawnError: code });
      return;
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      const room = opts.captureBytes - outLen;
      if (room > 0) {
        const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
        out.push(part);
        outLen += part.byteLength;
      }
      if (chunk.byteLength > Math.max(room, 0)) stdoutOverflow = true;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      const room = opts.captureBytes - errLen;
      if (room > 0) {
        const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
        err.push(part);
        errLen += part.byteLength;
      }
      if (chunk.byteLength > Math.max(room, 0)) stderrOverflow = true;
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish({ exitCode: 127, timedOut: false, signal: null, spawnError: e.code ?? "spawn_failed" });
    });
    child.on("close", (code, signal) => {
      // Reap anything the command left behind in its process group.
      killTree(child.pid, "SIGKILL");
      if (timedOut) {
        finish({ exitCode: 124, timedOut: true, signal: signal ?? null });
        return;
      }
      const exitCode =
        typeof code === "number" ? code : signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : 1;
      finish({ exitCode, timedOut: false, signal: signal ?? null });
    });
  });
}
