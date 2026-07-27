/**
 * Real local coding adapter — FS/process/checkpoints only inside a linked disposable worktree.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ToolHandler } from "../runtime.js";
import type { AgentIR, Deployment, ToolResultEnvelope } from "../types.js";
import {
  assertInScope,
  resolveContainedPath,
  SandboxPathError,
  scopeCovered,
  validateLinkedWorktree,
} from "./sandbox-path.js";

const execFileAsync = promisify(execFile);

export type LocalWorldOptions = {
  workspace: string;
  agent: AgentIR;
  deployment: Deployment;
  /** Interactive terminal checkpoints (default true). */
  interactive?: boolean;
  /** Force auto-approve/correct for disposable E2E (only with *_auto natives). */
  autoApprove?: boolean;
};

export type LocalWorld = {
  root: string;
  readScopes: string[];
  writeScopes: string[];
  maxReadBytes: number;
  maxOutputBytes: number;
  shellTimeoutMs: number;
  commands: Record<string, string[]>;
  interactive: boolean;
  autoApprove: boolean;
  outOfScopeWrites: number;
};

function narrowScopes(agentScopes: string[] | undefined, deploymentScopes: string[] | undefined): string[] {
  const base = agentScopes ?? [];
  if (!deploymentScopes || deploymentScopes.length === 0) return base;
  // Deployment may only narrow: every deployment scope must be covered by some agent scope.
  for (const d of deploymentScopes) {
    if (base.length > 0 && !scopeCovered(d.replace(/\\/g, "/"), base)) {
      throw new SandboxPathError(
        "scope_denied",
        `deployment scope '${d}' widens agent scopes`,
      );
    }
  }
  return deploymentScopes;
}

export function createLocalWorld(opts: LocalWorldOptions): LocalWorld {
  const { root } = validateLinkedWorktree(opts.workspace);
  const world = opts.deployment.world ?? {};
  if (world.worktree_root) {
    const declared = validateLinkedWorktree(world.worktree_root).root;
    if (declared !== root) {
      throw new SandboxPathError(
        "worktree_invalid",
        "deployment.world.worktree_root must match --workspace",
      );
    }
  }
  const agentFs = opts.agent.permissions?.filesystem;
  const depScopes = world.scopes;
  return {
    root,
    readScopes: narrowScopes(agentFs?.read_scopes, depScopes?.read),
    writeScopes: narrowScopes(agentFs?.write_scopes, depScopes?.write),
    maxReadBytes: world.max_read_bytes ?? 256_000,
    maxOutputBytes: world.max_output_bytes ?? 64_000,
    shellTimeoutMs: world.shell_timeout_ms ?? 30_000,
    commands: {
      test: world.commands?.test ?? ["node", "--test"],
      typecheck: world.commands?.typecheck ?? ["npx", "tsc", "--noEmit"],
      ...(world.commands ?? {}),
    },
    interactive: opts.interactive ?? true,
    autoApprove: opts.autoApprove ?? false,
    outOfScopeWrites: 0,
  };
}

function toRelUnderRoot(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, "/");
}

function truncateUtf8(buf: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  const slice = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  return {
    text: slice.toString("utf8"),
    truncated: buf.byteLength > maxBytes,
  };
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

async function promptJsonObject(question: string): Promise<Record<string, unknown>> {
  if (!process.stdin.isTTY) return {};
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });
    if (!answer.trim()) return {};
    const parsed = JSON.parse(answer) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  } finally {
    rl.close();
  }
}

function errEnvelope(code: string, message: string): ToolResultEnvelope {
  return { output: { ok: 0, error: code, message } };
}

export function createLocalCodingTools(world: LocalWorld): Record<string, ToolHandler> {
  const fsRead: ToolHandler = (args) => {
    try {
      const rel = String(args.path ?? "");
      assertInScope(rel.replace(/\\/g, "/"), world.readScopes.length ? world.readScopes : undefined, "read");
      const abs = resolveContainedPath(world.root, rel);
      if (!existsSync(abs)) {
        return { output: { path: rel.replace(/\\/g, "/"), content: "", found: 0 } };
      }
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        return {
          output: {
            path: toRelUnderRoot(world.root, abs) || rel.replace(/\\/g, "/"),
            content: "",
            found: 0,
            error: "is_directory",
          },
        };
      }
      const buf = readFileSync(abs);
      if (buf.byteLength > world.maxReadBytes) {
        return errEnvelope("read_too_large", `file exceeds max_read_bytes (${world.maxReadBytes})`);
      }
      const content = buf.toString("utf8");
      return {
        output: {
          path: toRelUnderRoot(world.root, abs) || rel.replace(/\\/g, "/"),
          content,
          found: 1,
        },
        state_transition: { set: { researched: 1 } },
      };
    } catch (e) {
      if (e instanceof SandboxPathError) {
        return errEnvelope(e.code, e.message);
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (/EISDIR|illegal operation on a directory/i.test(msg)) {
        return {
          output: {
            path: String(args.path ?? ""),
            content: "",
            found: 0,
            error: "is_directory",
          },
        };
      }
      throw e;
    }
  };

  const fsWrite: ToolHandler = (args) => {
    try {
      const rel = String(args.path ?? "");
      const content = String(args.content ?? "");
      const unified = rel.replace(/\\/g, "/");
      assertInScope(unified, world.writeScopes, "write");
      const abs = resolveContainedPath(world.root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.fausth-tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, content, { encoding: "utf8" });
      renameSync(tmp, abs);
      return { output: { ok: 1, out_of_scope: 0, path: unified } };
    } catch (e) {
      if (e instanceof SandboxPathError) {
        if (e.code === "scope_denied") {
          world.outOfScopeWrites += 1;
          return {
            output: { ok: 0, out_of_scope: 1, path: String(args.path ?? "") },
            state_transition: {
              set: { out_of_scope_writes: world.outOfScopeWrites },
            },
          };
        }
        return {
          output: { ok: 0, out_of_scope: 1, path: String(args.path ?? ""), error: e.message },
        };
      }
      throw e;
    }
  };

  const shell: ToolHandler = async (args) => {
    const cmd = String(args.cmd ?? "");
    const argv = world.commands[cmd];
    if (!argv || argv.length === 0) {
      return { output: { exit_code: 1, cmd, error: "not allowlisted" } };
    }
    const [bin, ...rest] = argv;
    if (!bin) {
      return { output: { exit_code: 1, cmd, error: "empty command argv" } };
    }
    try {
      const { stdout, stderr } = await execFileAsync(bin, rest, {
        cwd: world.root,
        timeout: world.shellTimeoutMs,
        maxBuffer: world.maxOutputBytes,
        windowsHide: true,
        shell: false,
        encoding: "buffer",
      } as Parameters<typeof execFileAsync>[2]);
      const out = truncateUtf8(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)), world.maxOutputBytes);
      const err = truncateUtf8(Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr)), world.maxOutputBytes);
      return {
        output: {
          exit_code: 0,
          cmd,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated ? 1 : 0,
        },
        state_transition: { set: { test_evidence_current: 1 } },
      };
    } catch (e: unknown) {
      const err = e as {
        code?: number | string;
        killed?: boolean;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        message?: string;
      };
      const exitCode =
        typeof err.code === "number" ? err.code : err.killed ? 124 : 1;
      const out = truncateUtf8(
        Buffer.isBuffer(err.stdout) ? err.stdout : Buffer.from(String(err.stdout ?? "")),
        world.maxOutputBytes,
      );
      const serr = truncateUtf8(
        Buffer.isBuffer(err.stderr) ? err.stderr : Buffer.from(String(err.stderr ?? err.message ?? "")),
        world.maxOutputBytes,
      );
      return {
        output: {
          exit_code: exitCode,
          cmd,
          stdout: out.text,
          stderr: serr.text,
          truncated: out.truncated || serr.truncated ? 1 : 0,
        },
      };
    }
  };

  const approveInteractive: ToolHandler = async () => {
    const approved = world.interactive ? await promptYesNo("Approve plan? [y/N] ") : false;
    if (approved) {
      return {
        output: { approved: 1 },
        state_transition: { set: { plan_approved: 1 } },
      };
    }
    return { output: { approved: 0 } };
  };

  const approveAuto: ToolHandler = () => ({
    output: { approved: 1 },
    state_transition: { set: { plan_approved: 1 } },
  });

  const correctInteractive: ToolHandler = async (args) => {
    let set = (args.set as Record<string, unknown>) ?? {};
    if (world.interactive && Object.keys(set).length === 0) {
      set = await promptJsonObject("user.correct set JSON (empty to skip): ");
    }
    return {
      output: { ok: 1 },
      state_transition: { set },
    };
  };

  const correctAuto: ToolHandler = (args) => {
    const set = (args.set as Record<string, unknown>) ?? { open_todos: 0 };
    return {
      output: { ok: 1 },
      state_transition: { set },
    };
  };

  return {
    "fs.read": fsRead,
    "fs.write_scoped": fsWrite,
    "shell.run_allowlisted": shell,
    "user.approve": approveInteractive,
    "user.correct": correctInteractive,
    "mode.enter": (args): ToolResultEnvelope => {
      const mode = String(args.mode ?? "");
      return {
        output: { ok: 1, mode },
        state_transition: { set: { mode } },
      };
    },
    "task.complete": (): ToolResultEnvelope => ({ output: { ok: 1 } }),
    // Internal keys used by registry for *_auto natives
    "__local.user_approve_auto": approveAuto,
    "__local.user_correct_auto": correctAuto,
  };
}

/**
 * Resolve local.* handlers. When native is *_auto, use non-interactive bindings.
 */
export function pickLocalHandler(
  tools: Record<string, ToolHandler>,
  toolId: string,
  native: string,
): ToolHandler | undefined {
  if (native === "local.user_approve_auto") return tools["__local.user_approve_auto"];
  if (native === "local.user_correct_auto") return tools["__local.user_correct_auto"];
  return tools[toolId];
}

/** Detect whether a deployment uses any local.* native. */
export function deploymentUsesLocal(deployment: Deployment): boolean {
  return Object.values(deployment.bindings ?? {}).some(
    (b) => typeof b.native === "string" && b.native.startsWith("local."),
  );
}

/** Detect stub/sim natives. */
export function deploymentUsesSimOrStub(deployment: Deployment): boolean {
  return Object.values(deployment.bindings ?? {}).some((b) => {
    const n = b.native;
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
