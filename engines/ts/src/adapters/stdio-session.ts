/**
 * Shared host-session plumbing for MCP and module connectors (EDGE-8/9/10/23, PY-3):
 *
 * - one line-delimited JSON child process abstraction with an 'error' listener (ENOENT no
 *   longer crashes the host), drained + bounded stderr, and an allowlisted environment;
 * - MCP sessions match replies by JSON-RPC id; module sessions (protocol has no ids) are
 *   serialized and torn down after a timeout so a late reply can never be delivered to the
 *   next call;
 * - every live child is tracked and killed on cleanup / process exit (no orphans);
 * - spawn policy: a deployment that shipped inside a bundle may only spawn commands the
 *   operator allowed, and never from unsigned/untrusted bundles unless explicitly allowed;
 * - recorded (Track A) responses: path contained in the harness dir, exact args match only.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { canonicalJson } from "../canonical.js";
import { AdapterError } from "./error.js";
import { assertNoSecretEnvNames, buildChildEnv } from "./child-process.js";
import type { BundleProvenance } from "./provenance.js";

// ---------------------------------------------------------------------------
// Spawn policy (PY-3)
// ---------------------------------------------------------------------------

export type SpawnPolicy = {
  /** Set when the deployment file came from an unpacked bundle. */
  provenance?: BundleProvenance;
  /** Operator allowlist of exact command strings, or "*" for any. */
  allowCommands?: readonly string[] | "*";
  /** Operator explicitly accepts commands from unsigned / untrusted bundles. */
  allowUntrustedBundles?: boolean;
};

/** Operator allow from the environment: FAUSTH_ALLOW_COMMANDS, FAUSTH_ALLOW_UNTRUSTED_BUNDLE_COMMANDS. */
export function spawnPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<SpawnPolicy, "provenance"> {
  const raw = (env.FAUSTH_ALLOW_COMMANDS ?? "").trim();
  const allowCommands: readonly string[] | "*" =
    raw === "*" ? "*" : raw.split(",").map((s) => s.trim()).filter(Boolean);
  const untrusted = (env.FAUSTH_ALLOW_UNTRUSTED_BUNDLE_COMMANDS ?? "").trim();
  return { allowCommands, allowUntrustedBundles: untrusted === "1" || untrusted === "true" };
}

/** Refuse to spawn a bundle-declared command without operator allow (and trust). */
export function assertSpawnAllowed(command: string, policy: SpawnPolicy | undefined, label: string): void {
  const prov = policy?.provenance;
  if (!prov) return; // deployment provided by the operator (not from a bundle)
  const allow = policy?.allowCommands;
  const allowed = allow === "*" || (Array.isArray(allow) && allow.includes(command));
  if (!allowed) {
    throw new AdapterError(
      "spawn_not_allowed",
      `adapter failure: ${label} command '${command}' is declared by a deployment shipped inside bundle ${basename(prov.bundle)} (${prov.trust}); the operator must allow it (FAUSTH_ALLOW_COMMANDS)`,
    );
  }
  if (prov.trust !== "signed-trusted" && !policy?.allowUntrustedBundles) {
    throw new AdapterError(
      "spawn_not_allowed",
      `adapter failure: refusing to spawn '${command}' from a ${prov.trust} bundle (${basename(prov.bundle)}); sign it with a trusted key or set FAUSTH_ALLOW_UNTRUSTED_BUNDLE_COMMANDS=1`,
    );
  }
}

// ---------------------------------------------------------------------------
// Live child tracking (EDGE-10)
// ---------------------------------------------------------------------------

const liveChildren = new Set<JsonLineChild>();
let exitHookInstalled = false;

function trackChild(c: JsonLineChild): void {
  liveChildren.add(c);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => closeAllHostSessions());
  }
}

/** Kill every live host session (also runs automatically on process exit). */
export function closeAllHostSessions(): void {
  for (const c of [...liveChildren]) c.close();
}

export function liveHostSessionCount(): number {
  return liveChildren.size;
}

// ---------------------------------------------------------------------------
// Line-delimited JSON child
// ---------------------------------------------------------------------------

const STDERR_TAIL_BYTES = 8192;

export type ChildSpec = {
  command: string;
  args: readonly string[];
  /** Deployment-declared literal env (non-secret names only). */
  env?: Record<string, string>;
  /** Deployment-declared host env names to pass through (non-secret names only). */
  envPassthrough?: readonly string[];
  cwd?: string;
  label: string;
};

export class JsonLineChild {
  private proc: ChildProcessWithoutNullStreams;
  private rl: Interface;
  private stderrTail = "";
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandlers: Array<(err: Error) => void> = [];
  closed = false;

  constructor(spec: ChildSpec) {
    assertNoSecretEnvNames(Object.keys(spec.env ?? {}), spec.label);
    const env = buildChildEnv({ set: spec.env, passthrough: spec.envPassthrough }, spec.label);
    this.proc = spawn(spec.command, [...spec.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: spec.cwd,
      windowsHide: true,
      shell: false,
    });
    trackChild(this);
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.lineHandler?.(line));
    // Drain stderr so a chatty server can never block on a full pipe; keep a bounded tail.
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    this.proc.stdin.on("error", () => {
      /* EPIPE after the child died — surfaced via 'exit' */
    });
    this.proc.on("error", (err) => this.fail(new Error(`${spec.label} process error: ${err.message}`)));
    this.proc.on("exit", (code, signal) =>
      this.fail(new Error(`${spec.label} process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`)),
    );
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onExit(handler: (err: Error) => void): void {
    this.exitHandlers.push(handler);
  }

  write(obj: unknown): void {
    if (this.closed) throw new Error("session closed");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  stderr(): string {
    return this.stderrTail;
  }

  private fail(err: Error): void {
    const wasOpen = !this.closed;
    this.closed = true;
    liveChildren.delete(this);
    if (wasOpen) {
      for (const h of this.exitHandlers.splice(0)) h(err);
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      liveChildren.delete(this);
      for (const h of this.exitHandlers.splice(0)) h(new Error("session closed"));
    }
    try {
      this.rl.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC over stdio)
// ---------------------------------------------------------------------------

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export class McpStdioSession {
  private child: JsonLineChild;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(spec: ChildSpec, private timeoutMs: number) {
    this.child = new JsonLineChild(spec);
    this.child.onLine((line) => {
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return; // non-JSON noise on stdout is ignored
      }
      if (typeof msg.id !== "number") return;
      const p = this.pending.get(msg.id);
      if (!p) return; // late reply for a timed-out id: dropped, never re-attributed
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? "mcp error")));
      else p.resolve(msg.result);
    });
    this.child.onExit((err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  get closed(): boolean {
    return this.child.closed;
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.child.closed) return Promise.reject(new Error("mcp stdio session closed"));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp stdio timeout after ${this.timeoutMs}ms (${method})`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.child.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fausth", version: "0.4.0-alpha" },
    });
    this.child.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    } | null;
    if (result?.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
      return result.structuredContent as Record<string, unknown>;
    }
    const text = result?.content?.find((c) => c.type === "text")?.text;
    if (typeof text === "string") {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* fall through: plain text */
      }
      return { text };
    }
    throw new Error(`mcp tools/call '${name}' returned no structured result`);
  }

  stderr(): string {
    return this.child.stderr();
  }

  close(): void {
    this.child.close();
  }
}

// ---------------------------------------------------------------------------
// Module protocol: one JSON line {tool,args} → one JSON line {output}|{error}
// ---------------------------------------------------------------------------

export class ModuleStdioSession {
  private child: JsonLineChild;
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: { resolve: (line: string) => void; reject: (e: Error) => void } | null = null;
  private broken: Error | null = null;

  constructor(spec: ChildSpec, private timeoutMs: number) {
    this.child = new JsonLineChild(spec);
    this.child.onLine((line) => {
      const w = this.waiter;
      this.waiter = null;
      if (w) w.resolve(line);
      // Unsolicited lines (no request in flight) are ignored — never queued for a later call.
    });
    this.child.onExit((err) => {
      this.broken ??= err;
      const w = this.waiter;
      this.waiter = null;
      w?.reject(err);
    });
  }

  get closed(): boolean {
    return this.child.closed || this.broken !== null;
  }

  /** Calls are serialized: the protocol has no request ids. */
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = () => this.callOnce(name, args);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private callOnce(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.broken ?? new Error("module stdio session closed"));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        // A late reply could otherwise be delivered to the next call: tear the session down.
        const err = new Error(`module stdio timeout after ${this.timeoutMs}ms (${name})`);
        this.broken = err;
        this.child.close();
        reject(err);
      }, this.timeoutMs);
      this.waiter = {
        resolve: (line) => {
          clearTimeout(timer);
          try {
            const msg = JSON.parse(line) as { output?: unknown; error?: unknown };
            if (msg.error !== undefined && msg.error !== null) {
              reject(new Error(String(msg.error)));
              return;
            }
            if (!msg.output || typeof msg.output !== "object" || Array.isArray(msg.output)) {
              reject(new Error(`module stdio '${name}' returned no output object`));
              return;
            }
            resolvePromise(msg.output as Record<string, unknown>);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      try {
        this.child.write({ tool: name, args });
      } catch (e) {
        clearTimeout(timer);
        this.waiter = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  stderr(): string {
    return this.child.stderr();
  }

  close(): void {
    this.child.close();
  }
}

// ---------------------------------------------------------------------------
// Recorded (Track A) responses
// ---------------------------------------------------------------------------

export type RecordedEntry = {
  tool: string;
  args?: Record<string, unknown>;
  result: Record<string, unknown>;
};

/** Resolve a deployment-declared harness-relative file, contained in the harness dir (PY-19). */
export function resolveHarnessFile(harnessDir: string, relPath: string, label: string): string {
  if (typeof relPath !== "string" || !relPath || relPath.includes("\0") || isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new AdapterError("adapter_unresolved", `adapter failure: ${label} path must be harness-relative: ${String(relPath)}`);
  }
  const unified = relPath.replace(/\\/g, "/");
  if (unified.split("/").includes("..")) {
    throw new AdapterError("adapter_unresolved", `adapter failure: ${label} path escapes the harness: ${relPath}`);
  }
  const rootReal = realpathSync.native(resolve(harnessDir));
  const abs = resolve(rootReal, unified);
  if (!existsSync(abs)) {
    throw new AdapterError("adapter_unresolved", `adapter failure: ${label} file not found: ${relPath}`);
  }
  const real = realpathSync.native(abs);
  if (real !== rootReal && !real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)) {
    throw new AdapterError("adapter_unresolved", `adapter failure: ${label} path escapes the harness: ${relPath}`);
  }
  return real;
}

export function loadRecordedEntries(harnessDir: string, relPath: string, label: string): RecordedEntry[] {
  const abs = resolveHarnessFile(harnessDir, relPath, `${label} recorded`);
  const entries: RecordedEntry[] = [];
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let row: RecordedEntry;
    try {
      row = JSON.parse(line) as RecordedEntry;
    } catch {
      throw new AdapterError("adapter_unresolved", `adapter failure: invalid ${label} recorded line ${i + 1} in ${relPath}`);
    }
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.tool !== "string" ||
      !row.result ||
      typeof row.result !== "object" ||
      Array.isArray(row.result) ||
      (row.args !== undefined && (typeof row.args !== "object" || row.args === null || Array.isArray(row.args)))
    ) {
      throw new AdapterError("adapter_unresolved", `adapter failure: invalid ${label} recorded line ${i + 1} in ${relPath}`);
    }
    entries.push(row);
  }
  return entries;
}

/**
 * First unused entry for `tool` whose args canonically equal the call args. There is no
 * tool-only fallback: returning another call's recorded result would make the trace lie.
 */
export function matchRecordedExact(
  entries: readonly RecordedEntry[],
  tool: string,
  args: Record<string, unknown>,
  used: Set<number>,
  label: string,
): Record<string, unknown> {
  const argsCanon = canonicalJson(args ?? {});
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const e = entries[i]!;
    if (e.tool !== tool) continue;
    if (canonicalJson(e.args ?? {}) !== argsCanon) continue;
    used.add(i);
    return e.result;
  }
  throw new AdapterError(
    "recorded_response_missing",
    `adapter failure: no recorded ${label} response for tool '${tool}' with these args`,
  );
}
