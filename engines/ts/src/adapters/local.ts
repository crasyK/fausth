/**
 * Real local coding adapter — FS/process/checkpoints only inside a linked disposable worktree.
 *
 * Generic: contains no domain/harness-specific file names and writes no harness state key
 * by name (D11) — handlers report what happened in the world (outputs and world-derived
 * counters); the IR's declared tool `effects` map results to memory. Domain worlds (e.g. the
 * τ retail world in ./worlds/tau.ts) plug in through {@link LocalWorldExtension}: host control
 * paths the agent may never write and command keys reserved for host natives. The user cell
 * (approvals, corrections, questions) is never answered here — only by the user channel (D14).
 *
 * Trust boundary (see docs/production-isolation.md): this is NOT a sandbox. Commands run
 * with the operator's uid. What the adapter does guarantee:
 *  - all checks (scope, host-control, protected, secret, plan) happen before any write;
 *  - checks run on normalized lexical paths AND resolved real paths (D7);
 *  - world commands get an allowlisted environment (no API keys/tokens), a private HOME,
 *    bounded + secret-redacted output (D13) and their true exit code;
 *  - protected files, host control files and the git hooks/config are verified and
 *    restored after every command.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ToolHandler } from "../runtime.js";
import type { AgentIR, Deployment, ToolResultEnvelope } from "../types.js";
import {
  assertInScope,
  normalizeDeclaredPath,
  normalizeScopes,
  normalizeToolPath,
  pathListed,
  resolveAccess,
  resolveContainedPath,
  ROOT_SCOPE,
  SandboxPathError,
  scopeCovered,
  validateLinkedWorktree,
} from "./sandbox-path.js";
import { loadApprovedWritePaths } from "./plan-paths.js";
import { SHELL_NOT_ALLOWLISTED_ERROR } from "../tools/world.js";
import {
  buildChildEnv,
  hostSecretValues,
  redactSecrets,
  runCommandCaptured,
  truncateCodePoints,
} from "./child-process.js";

export { SHELL_NOT_ALLOWLISTED_ERROR };

/** Domain-world hooks into the generic local world. */
export type LocalWorldExtension = {
  /** Host control files (exact) or directories (ending in '/') — never agent-writable. */
  controlPaths?: string[];
  /** `deployment.world.commands` keys reserved for host natives (not runnable via shell). */
  claimedCommands?: string[];
};

export type LocalWorldOptions = {
  workspace: string;
  agent: AgentIR;
  deployment: Deployment;
  /** @deprecated unused: checkpoints are answered by the user channel (D14). */
  interactive?: boolean;
  /** @deprecated unused: there are no auto-approving natives (D14). */
  autoApprove?: boolean;
  /** Host-approved plan write paths; take precedence over the worktree snapshot file. */
  approvedWritePaths?: string[];
  extensions?: LocalWorldExtension[];
};

/** Deployment world settings (shared type, incl. env / env_passthrough). */
type WorldConfig = NonNullable<Deployment["world"]>;

export type LocalWorld = {
  root: string;
  gitCommonDir?: string;
  /** undefined = unrestricted reads inside the worktree (agent declared no read scopes). */
  readScopes: string[] | undefined;
  writeScopes: string[];
  maxReadBytes: number;
  maxOutputBytes: number;
  shellTimeoutMs: number;
  commands: Map<string, string[]>;
  claimedCommands: Set<string>;
  outOfScopeWrites: number;
  /** Off-plan writes so far (world-derived counter; warn once, then deny). */
  offPlanWrites: number;
  secretPaths: string[];
  secretValues: Set<string>;
  denyWriteContains: boolean;
  protectedPaths: string[];
  /** Baseline bytes; null = missing at init. */
  protectedBaseline: Map<string, Buffer | null>;
  controlPaths: string[];
  /** Host-approved write paths captured before the agent acts (null = none). */
  approvedWritePaths: string[] | null;
  childEnv: Record<string, string>;
  privateHome: string;
  /** Git hooks/config snapshot (host-owned files outside the agent's reach). */
  gitBaseline: Map<string, Buffer | null>;
  /** Host-side record of tamper events (not shown to the agent). */
  tamperLog: string[];
};

/** Host control directory: always reserved, regardless of domain extensions. */
const HOST_CONTROL_DIR = ".fausth/";

function narrowScopes(
  agentScopes: string[] | undefined,
  deploymentScopes: string[] | undefined,
  kind: "read" | "write",
): string[] | undefined {
  // Agent-declared scopes: absent read scopes = unrestricted; absent write scopes = none.
  const base: string[] | undefined =
    agentScopes === undefined ? (kind === "read" ? undefined : []) : normalizeScopes(agentScopes);
  if (deploymentScopes === undefined) return base;
  const dep = normalizeScopes(deploymentScopes);
  for (const d of dep) {
    const covered = base === undefined || scopeCovered(d === ROOT_SCOPE ? "." : d, base);
    const rootWidening = d === ROOT_SCOPE && base !== undefined && !base.includes(ROOT_SCOPE);
    if (!covered || rootWidening) {
      throw new SandboxPathError("scope_denied", `deployment ${kind} scope '${d}' widens agent scopes`);
    }
  }
  return dep;
}

function validateCommands(raw: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  out.set("test", ["node", "--test"]);
  out.set("typecheck", ["npx", "tsc", "--noEmit"]);
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SandboxPathError("path_invalid", "deployment.world.commands must be an object");
  }
  for (const key of Object.keys(raw)) {
    const argv = (raw as Record<string, unknown>)[key];
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string" || a.length === 0)) {
      throw new SandboxPathError("path_invalid", `deployment.world.commands.${key} must be a non-empty argv list`);
    }
    out.set(key, [...(argv as string[])]);
  }
  return out;
}

function readBytesOrNull(abs: string): Buffer | null {
  try {
    if (existsSync(abs) && lstatSync(abs).isFile()) return readFileSync(abs);
  } catch {
    /* unreadable → treated as missing */
  }
  return null;
}

function snapshotGit(gitCommonDir: string | undefined, root: string): Map<string, Buffer | null> {
  const snap = new Map<string, Buffer | null>();
  if (!gitCommonDir) return snap;
  const hooks = join(gitCommonDir, "hooks");
  if (existsSync(hooks)) {
    for (const name of readdirSync(hooks).sort()) {
      snap.set(join(hooks, name), readBytesOrNull(join(hooks, name)));
    }
  }
  snap.set(join(gitCommonDir, "config"), readBytesOrNull(join(gitCommonDir, "config")));
  snap.set(join(root, ".git"), readBytesOrNull(join(root, ".git")));
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    snap.set(join(gitDir, "config.worktree"), readBytesOrNull(join(gitDir, "config.worktree")));
  } catch {
    /* not fatal */
  }
  return snap;
}

export function createLocalWorld(opts: LocalWorldOptions): LocalWorld {
  const { root, gitCommonDir } = validateLinkedWorktree(opts.workspace);
  const world = (opts.deployment.world ?? {}) as WorldConfig;
  if (world.worktree_root) {
    const declared = validateLinkedWorktree(world.worktree_root).root;
    if (declared !== root) {
      throw new SandboxPathError("worktree_invalid", "deployment.world.worktree_root must match --workspace");
    }
  }
  const agentFs = opts.agent.permissions?.filesystem;
  const depScopes = world.scopes;
  const secrets = opts.agent.permissions?.secrets;
  const secretPaths = (secrets?.paths ?? []).map(normalizeDeclaredPath);
  const secretValues = new Set<string>();
  for (const v of secrets?.values ?? []) {
    const t = String(v).trim();
    if (t) secretValues.add(t);
  }
  const denyWriteContains = secrets ? secrets.deny_write_contains !== false : false;
  // Seed secret values from labeled paths already on disk.
  for (const p of secretPaths) {
    try {
      const buf = readBytesOrNull(resolveContainedPath(root, p));
      const t = buf?.toString("utf8").trim();
      if (t) secretValues.add(t);
    } catch {
      /* path may not exist yet */
    }
  }
  const protectedPaths = (opts.agent.permissions?.protected_paths ?? []).map(normalizeDeclaredPath);
  const protectedBaseline = new Map<string, Buffer | null>();
  for (const p of protectedPaths) {
    try {
      protectedBaseline.set(p, readBytesOrNull(resolveContainedPath(root, p)));
    } catch {
      protectedBaseline.set(p, null);
    }
  }
  const controlPaths = [HOST_CONTROL_DIR];
  const claimedCommands = new Set<string>();
  for (const ext of opts.extensions ?? []) {
    for (const c of ext.controlPaths ?? []) {
      const isDir = c.endsWith("/");
      const n = normalizeDeclaredPath(c);
      controlPaths.push(isDir ? `${n}/` : n);
    }
    for (const k of ext.claimedCommands ?? []) claimedCommands.add(k);
  }
  const privateHome = mkdtempSync(join(tmpdir(), "fausth-world-home-"));
  trackPrivateHome(privateHome);
  return {
    root,
    gitCommonDir,
    readScopes: narrowScopes(agentFs?.read_scopes, depScopes?.read, "read"),
    writeScopes: narrowScopes(agentFs?.write_scopes, depScopes?.write, "write") ?? [],
    maxReadBytes: world.max_read_bytes ?? 256_000,
    maxOutputBytes: world.max_output_bytes ?? 64_000,
    shellTimeoutMs: world.shell_timeout_ms ?? 30_000,
    commands: validateCommands(world.commands),
    claimedCommands,
    outOfScopeWrites: 0,
    offPlanWrites: 0,
    secretPaths,
    secretValues,
    denyWriteContains,
    protectedPaths,
    protectedBaseline,
    controlPaths,
    approvedWritePaths:
      opts.approvedWritePaths?.map((p) => normalizeToolPath(p)) ?? loadApprovedWritePaths(root),
    childEnv: buildChildEnv(
      { passthrough: world.env_passthrough, set: world.env, home: privateHome },
      "world command",
    ),
    privateHome,
    gitBaseline: snapshotGit(gitCommonDir, root),
    tamperLog: [],
  };
}

const privateHomes = new Set<string>();
let homeExitHook = false;

function trackPrivateHome(dir: string): void {
  privateHomes.add(dir);
  if (!homeExitHook) {
    homeExitHook = true;
    // Fallback for callers that never run the binding cleanup.
    process.once("exit", () => {
      for (const d of privateHomes) rmSync(d, { recursive: true, force: true });
    });
  }
}

/** Remove the world's private HOME (call when the run ends). */
export function disposeLocalWorld(world: LocalWorld): void {
  privateHomes.delete(world.privateHome);
  rmSync(world.privateHome, { recursive: true, force: true });
}

function protectionActive(world: LocalWorld): boolean {
  return world.protectedPaths.length > 0;
}

function protectFlags(world: LocalWorld): Record<string, number> {
  return protectionActive(world) ? { protected_modified: 0 } : {};
}

function isControlPath(world: LocalWorld, rel: string): boolean {
  return pathListed(rel, world.controlPaths);
}

/** Restore protected files from baseline; returns true if any drifted. */
function restoreLocalProtected(world: LocalWorld): boolean {
  let drifted = false;
  for (const p of world.protectedPaths) {
    const baseline = world.protectedBaseline.get(p) ?? null;
    let abs: string;
    try {
      abs = resolveContainedPath(world.root, p);
    } catch {
      // The path now resolves outside (e.g. replaced by an escaping symlink): remove the link.
      drifted = true;
      try {
        rmSync(join(world.root, p), { force: true });
      } catch {
        /* best effort */
      }
      continue;
    }
    const current = readBytesOrNull(abs);
    const same = current === null ? baseline === null : baseline !== null && current.equals(baseline);
    if (!same) {
      drifted = true;
      try {
        if (baseline === null) rmSync(abs, { force: true });
        else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, baseline);
        }
      } catch {
        /* best-effort restore */
      }
    }
  }
  return drifted;
}

/** Snapshot host control files under the worktree (exact entries + directory entries). */
function snapshotControl(world: LocalWorld): Map<string, Buffer | null> {
  const snap = new Map<string, Buffer | null>();
  const walk = (absDir: string, rel: string) => {
    if (!existsSync(absDir)) return;
    for (const name of readdirSync(absDir).sort()) {
      const childAbs = join(absDir, name);
      const childRel = `${rel}/${name}`;
      let st;
      try {
        st = lstatSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else snap.set(childRel, readBytesOrNull(childAbs));
    }
  };
  for (const c of world.controlPaths) {
    if (c.endsWith("/")) walk(join(world.root, c.slice(0, -1)), c.slice(0, -1));
    else snap.set(c, readBytesOrNull(join(world.root, c)));
  }
  return snap;
}

/** Restore control files to `before`; returns true if anything changed. */
function restoreControl(world: LocalWorld, before: Map<string, Buffer | null>): boolean {
  const after = snapshotControl(world);
  let changed = false;
  for (const [rel, cur] of after) {
    const prev = before.has(rel) ? before.get(rel)! : null;
    const same = cur === null ? prev === null : prev !== null && cur.equals(prev);
    if (!same) {
      changed = true;
      const abs = join(world.root, rel);
      if (prev === null) rmSync(abs, { force: true });
      else writeFileSync(abs, prev);
    }
  }
  for (const [rel, prev] of before) {
    if (prev !== null && !after.has(rel)) {
      changed = true;
      const abs = join(world.root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, prev);
    }
  }
  return changed;
}

/** Verify git hooks/config against the baseline and restore (EDGE-4). */
function restoreGit(world: LocalWorld): boolean {
  if (!world.gitCommonDir) return false;
  let changed = false;
  const hooks = join(world.gitCommonDir, "hooks");
  if (existsSync(hooks)) {
    for (const name of readdirSync(hooks)) {
      const p = join(hooks, name);
      if (!world.gitBaseline.has(p)) {
        changed = true;
        rmSync(p, { recursive: true, force: true });
      }
    }
  }
  for (const [p, prev] of world.gitBaseline) {
    const cur = readBytesOrNull(p);
    const same = cur === null ? prev === null : prev !== null && cur.equals(prev);
    if (!same) {
      changed = true;
      try {
        if (prev === null) rmSync(p, { recursive: true, force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, prev);
        }
      } catch {
        /* best effort */
      }
    }
  }
  return changed;
}

export type WorldCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  spawnError?: string;
  /** Protected files, host control files or git hooks/config were modified (and restored). */
  tampered: boolean;
};

/**
 * Run a deployment-declared world command: scrubbed env + private HOME, bounded and
 * secret-redacted output, true exit code; afterwards verify/restore protected paths,
 * host control files and git hooks/config.
 */
export async function runWorldCommand(
  world: LocalWorld,
  argv: readonly string[],
  opts: {
    /**
     * Host natives whose deployment command legitimately maintains host control files
     * (e.g. a domain world's API log). Agent-triggered commands never get this.
     */
    hostControlWrites?: boolean;
  } = {},
): Promise<WorldCommandResult> {
  const [bin, ...rest] = argv;
  if (!bin) throw new SandboxPathError("path_invalid", "empty command argv");
  const controlBefore = opts.hostControlWrites ? null : snapshotControl(world);
  // Capture a margin beyond the observation cap so redaction never sees a split secret.
  const captureBytes = world.maxOutputBytes + 8192;
  const run = await runCommandCaptured(bin, rest, {
    cwd: world.root,
    env: world.childEnv,
    timeoutMs: world.shellTimeoutMs,
    captureBytes,
  });
  const secrets = [...world.secretValues, ...hostSecretValues()];
  const shape = (buf: Buffer, overflow: boolean) => {
    const redacted = redactSecrets(buf.toString("utf8"), secrets);
    const cut = truncateCodePoints(redacted, world.maxOutputBytes);
    return { text: cut.text, truncated: cut.truncated || overflow };
  };
  const out = shape(run.stdout, run.stdoutOverflow);
  const err = shape(run.stderr, run.stderrOverflow);
  const protectedDrift = protectionActive(world) && restoreLocalProtected(world);
  const controlDrift = controlBefore ? restoreControl(world, controlBefore) : false;
  const gitDrift = restoreGit(world);
  if (protectedDrift) world.tamperLog.push("protected_paths");
  if (controlDrift) world.tamperLog.push("host_control_paths");
  if (gitDrift) world.tamperLog.push("git_hooks_or_config");
  return {
    exitCode: run.exitCode,
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    tampered: protectedDrift || controlDrift || gitDrift,
  };
}

type WriteDecision =
  | { kind: "deny"; envelope: ToolResultEnvelope }
  | { kind: "write"; abs: string; rel: string; realRel: string; offPlan: boolean };

export function createLocalCodingTools(world: LocalWorld): Record<string, ToolHandler> {
  const readScopes = world.readScopes;

  const fsRead: ToolHandler = (args) => {
    const requested = String(args.path ?? "");
    const unified = requested.replace(/\\/g, "/");
    const refused = (code: string): ToolResultEnvelope => ({
      output: { path: unified, content: "", found: 0, error: code },
    });
    try {
      const access = resolveAccess(world.root, requested);
      assertInScope(access, readScopes, "read");
      if (!existsSync(access.abs)) {
        return { output: { path: access.rel, content: "", found: 0 } };
      }
      const st = lstatSync(access.abs);
      if (st.isDirectory()) {
        return { output: { path: access.rel, content: "", found: 0, error: "is_directory" } };
      }
      if (st.size > world.maxReadBytes) return refused("read_too_large");
      const buf = readFileSync(access.abs);
      if (buf.byteLength > world.maxReadBytes) return refused("read_too_large");
      const content = buf.toString("utf8");
      if (pathListed(access.rel, world.secretPaths) || pathListed(access.realRel, world.secretPaths)) {
        const t = content.trim();
        if (t) world.secretValues.add(t);
      }
      return { output: { path: access.rel, content, found: 1 } };
    } catch (e) {
      if (e instanceof SandboxPathError) return refused(e.code);
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EISDIR") return refused("is_directory");
      if (code === "EACCES" || code === "EPERM") return refused("permission_denied");
      throw e;
    }
  };

  const fsList: ToolHandler = (args) => {
    const requested = String(args.path ?? "");
    const unified = requested.replace(/\\/g, "/");
    const refused = (code: string): ToolResultEnvelope => ({
      output: { path: unified, entries: [] as string[], found: 0, error: code },
    });
    try {
      const access = resolveAccess(world.root, requested);
      assertInScope(access, readScopes, "read");
      if (!existsSync(access.abs)) {
        return { output: { path: access.rel, entries: [], found: 0 } };
      }
      if (!lstatSync(access.abs).isDirectory()) {
        return { output: { path: access.rel, entries: [], found: 0, error: "not_directory" } };
      }
      const entries = readdirSync(access.abs)
        .filter((n) => n.toLowerCase() !== ".git")
        .sort();
      return { output: { path: access.rel, entries, found: 1 } };
    } catch (e) {
      if (e instanceof SandboxPathError) return refused(e.code);
      throw e;
    }
  };

  /** Every check runs before any byte is written (EDGE-2). */
  const decideWrite = (requested: string, content: string): WriteDecision => {
    const leakCheck = world.denyWriteContains;
    const unified = requested.replace(/\\/g, "/");
    const outOfScope = (error?: string): WriteDecision => {
      world.outOfScopeWrites += 1;
      return {
        kind: "deny",
        envelope: {
          output: {
            ok: 0,
            out_of_scope: 1,
            path: unified,
            ...(error ? { error } : {}),
            ...(leakCheck ? { secret_leak: 0 } : {}),
            ...protectFlags(world),
          },
          state_transition: { set: { out_of_scope_writes: world.outOfScopeWrites } },
        },
      };
    };
    let access;
    try {
      access = resolveAccess(world.root, requested);
    } catch (e) {
      if (e instanceof SandboxPathError) return outOfScope(e.code);
      throw e;
    }
    const path = access.rel;
    // 1) Host control files (EDGE-6): never agent-writable, through any alias.
    if (isControlPath(world, access.rel) || isControlPath(world, access.realRel)) {
      return outOfScope("host_reserved");
    }
    // 2) Write scopes on the lexical AND real path (EDGE-7).
    try {
      assertInScope(access, world.writeScopes, "write");
    } catch (e) {
      if (e instanceof SandboxPathError) return outOfScope(e.code === "scope_denied" ? undefined : e.code);
      throw e;
    }
    if (access.rel === ROOT_SCOPE) return outOfScope("path_invalid");
    if (existsSync(access.abs) && lstatSync(access.abs).isDirectory()) {
      return {
        kind: "deny",
        envelope: {
          output: { ok: 0, out_of_scope: 0, path, error: "is_directory", ...(leakCheck ? { secret_leak: 0 } : {}), ...protectFlags(world) },
        },
      };
    }
    // 3) Protected paths on the normalized and real path (EDGE-5).
    if (
      protectionActive(world) &&
      (pathListed(access.rel, world.protectedPaths) || pathListed(access.realRel, world.protectedPaths))
    ) {
      return {
        kind: "deny",
        envelope: {
          output: { ok: 0, out_of_scope: 0, protected_modified: 1, path, ...(leakCheck ? { secret_leak: 0 } : {}) },
        },
      };
    }
    // 4) Secret leak.
    if (leakCheck) {
      for (const s of world.secretValues) {
        if (s && content.includes(s)) {
          return {
            kind: "deny",
            envelope: { output: { ok: 0, out_of_scope: 0, secret_leak: 1, path, ...protectFlags(world) } },
          };
        }
      }
    }
    // 5) Plan paths (warn-then-deny). Approvals are host-provided (deployment option or the
    //    host record snapshotted at world creation) — never read from harness state (D11).
    const allowedPaths =
      world.approvedWritePaths && world.approvedWritePaths.length > 0 ? world.approvedWritePaths : null;
    if (allowedPaths && !scopeCovered(access.rel, allowedPaths)) {
      if (world.offPlanWrites >= 1) {
        return {
          kind: "deny",
          envelope: {
            output: {
              ok: 0,
              out_of_scope: 0,
              path,
              error: "off_plan_path",
              approved_paths: [...allowedPaths],
              ...(leakCheck ? { secret_leak: 0 } : {}),
              ...protectFlags(world),
            },
          },
        };
      }
      return { kind: "write", abs: access.abs, rel: access.rel, realRel: access.realRel, offPlan: true };
    }
    return { kind: "write", abs: access.abs, rel: access.rel, realRel: access.realRel, offPlan: false };
  };

  const fsWrite: ToolHandler = (args) => {
    const content = String(args.content ?? "");
    const decision = decideWrite(String(args.path ?? ""), content);
    if (decision.kind === "deny") return decision.envelope;
    const leakCheck = world.denyWriteContains;
    mkdirSync(dirname(decision.abs), { recursive: true });
    const tmp = `${decision.abs}.fausth-tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, decision.abs);
    // Only a world-derived counter is reported as a transition (spec-v0.3 §2.3).
    const set: Record<string, unknown> = {};
    if (decision.offPlan) {
      world.offPlanWrites += 1;
      set.off_plan_writes = world.offPlanWrites;
    }
    return {
      output: {
        ok: 1,
        out_of_scope: 0,
        ...(decision.offPlan ? { off_plan: 1 } : {}),
        path: decision.rel,
        ...(leakCheck ? { secret_leak: 0 } : {}),
        ...protectFlags(world),
      },
      ...(Object.keys(set).length ? { state_transition: { set } } : {}),
    };
  };

  const shell: ToolHandler = async (args) => {
    const cmd = String(args.cmd ?? "");
    const argv =
      world.commands.has(cmd) && !world.claimedCommands.has(cmd) ? world.commands.get(cmd)! : undefined;
    if (!argv) {
      return {
        output: { exit_code: 1, cmd, error: SHELL_NOT_ALLOWLISTED_ERROR, ...protectFlags(world) },
      };
    }
    const r = await runWorldCommand(world, argv);
    const output: Record<string, unknown> = {
      exit_code: r.exitCode,
      cmd,
      stdout: r.stdout,
      stderr: r.stderr,
      truncated: r.truncated ? 1 : 0,
      ...(r.timedOut ? { error: "timeout" } : r.spawnError ? { error: "command_unavailable" } : {}),
    };
    if (r.tampered) {
      return { output: { ...output, protected_modified: 1 } };
    }
    // World feedback only: "tests pass ⇒ evidence current" is the IR's declared effect (D11).
    return { output: { ...output, ...protectFlags(world) } };
  };

  return {
    "fs.read": fsRead,
    "fs.list": fsList,
    "fs.write_scoped": fsWrite,
    "shell.run_allowlisted": shell,
    "task.complete": (): ToolResultEnvelope => ({ output: { ok: 1 } }),
    "harness.propose_skills_patch": (): ToolResultEnvelope => ({
      output: { ok: 1, proposed: 1 },
    }),
    "harness.decline_skills_patch": (): ToolResultEnvelope => ({
      output: { ok: 1, declined: 1 },
    }),
    "harness.reflect_skills": (args): ToolResultEnvelope => {
      if (args.disposition === "propose") {
        return { output: { ok: 1, disposition: "propose", proposed: 1 } };
      }
      return { output: { ok: 1, disposition: "decline", declined: 1 } };
    },
    "phase.yield": (): ToolResultEnvelope => ({ output: { ok: 1 } }),
  };
}

/** Resolve a local.* handler for a harness tool (own keys only). */
export function pickLocalHandler(
  tools: Record<string, ToolHandler>,
  toolId: string,
  _native: string,
): ToolHandler | undefined {
  return Object.prototype.hasOwnProperty.call(tools, toolId) ? tools[toolId] : undefined;
}

/** Detect whether a deployment uses any local.* native. */
export function deploymentUsesLocal(deployment: Deployment): boolean {
  return Object.values(deployment.bindings ?? {}).some(
    (b) => typeof b?.native === "string" && b.native.startsWith("local."),
  );
}

/** Detect stub/sim natives. */
export function deploymentUsesSimOrStub(deployment: Deployment): boolean {
  return Object.values(deployment.bindings ?? {}).some((b) => {
    const n = b?.native;
    return typeof n === "string" && (n.startsWith("stub.") || n.startsWith("sim."));
  });
}

export function assertBindingFamilyConsistency(deployment: Deployment): void {
  if (deploymentUsesLocal(deployment) && deploymentUsesSimOrStub(deployment)) {
    throw new Error(
      "deployment mixes local.* bindings with stub.*/sim.* — use a single binding family",
    );
  }
}

/** Bootstrap helper: create a linked worktree under parentRepo at path. */
export function addLinkedWorktree(parentRepo: string, worktreePath: string, branch?: string): void {
  mkdirSync(dirname(worktreePath), { recursive: true });
  const args = branch
    ? ["worktree", "add", "-b", branch, worktreePath, "HEAD"]
    : ["worktree", "add", "--detach", worktreePath];
  execFileSync("git", args, { cwd: parentRepo, stdio: "pipe", windowsHide: true });
}
