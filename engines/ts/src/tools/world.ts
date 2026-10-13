import { createHash } from "node:crypto";
import type { ToolHandler } from "../runtime.js";
import type { ToolResultEnvelope } from "../types.js";
import {
  normalizeScopes,
  normalizeToolPath,
  pathListed,
  ROOT_SCOPE,
  SandboxPathError,
  scopeCovered,
} from "../adapters/sandbox-path.js";

/** In-memory greenhouse world for stubs + fixtures. */
export type GreenhouseWorld = {
  temperature_decidegrees: number;
  fan_percent: number;
  sensor_healthy: number; // 1 | 0
};

export function createGreenhouseTools(world: GreenhouseWorld): Record<string, ToolHandler> {
  return {
    "sensor.temperature.read": (): ToolResultEnvelope => ({
      output: { celsius_decidegrees: world.temperature_decidegrees },
    }),
    "sensor.fan.read_percent": (): ToolResultEnvelope => ({
      output: { percent: world.fan_percent },
    }),
    "actuator.fan.set": (args): ToolResultEnvelope => {
      const percent = Number(args.percent);
      world.fan_percent = percent;
      return {
        output: { ok: 1, percent },
        state_transition: { set: { fan_percent: percent } },
      };
    },
    "system.wait": (args): ToolResultEnvelope => ({
      output: { waited_ms: Number(args.ms ?? 0) },
    }),
  };
}

export type CodingWorld = {
  files: Record<string, string>;
  /** Normalized write scopes; [] = no writes (absent agent write_scopes means none). */
  write_scopes: string[];
  /** Normalized read scopes; undefined = unrestricted (agent declared none). */
  read_scopes?: string[];
  last_exit_code: number;
  /** Scripted exit codes per allowlisted command (own keys only); test/typecheck default to last_exit_code. */
  exit_codes?: Record<string, number>;
  out_of_scope_writes: number;
  /** Paths whose contents are treated as secrets when present in files / after read. */
  secret_paths?: string[];
  /** Literal forbidden substrings (also populated from secret_paths). */
  secret_values?: Set<string>;
  /** When true (default if any secrets configured), block writes containing secrets. */
  deny_write_contains?: boolean;
  /** Paths that must keep baseline content (absence of change). */
  protected_paths?: string[];
  /** Baseline content per protected path; null means missing at init. */
  protected_baseline?: Record<string, string | null>;
};

/** One definition shared by the simulated and the real (local) world. */
export const SHELL_NOT_ALLOWLISTED_ERROR =
  "not allowlisted: only 'test' and 'typecheck' are available; use fs.read/fs.list to explore";

/** Host control directory: never writable by the agent in any world (mirrors adapters/local). */
const HOST_CONTROL_DIR = ".fausth";

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** D7 path normalization for the in-memory world (same rules as the local adapter). */
function normalizePath(raw: string): { ok: true; path: string } | { ok: false; code: string } {
  try {
    return { ok: true, path: normalizeToolPath(raw) };
  } catch (e) {
    return { ok: false, code: e instanceof SandboxPathError ? e.code : "path_invalid" };
  }
}

function listEntriesInMemory(path: string, files: Record<string, string>): string[] {
  const root = path === ROOT_SCOPE;
  const prefix = root ? "" : `${path}/`;
  const entries = new Set<string>();
  for (const key of Object.keys(files)) {
    if (!root && !key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length).split("/")[0];
    if (name) entries.add(name);
  }
  return [...entries].sort();
}

function readAllowed(world: CodingWorld, path: string): boolean {
  if (world.read_scopes === undefined) return true;
  return scopeCovered(path, world.read_scopes);
}

export function contentFingerprint(content: string | null | undefined): string {
  if (content === null || content === undefined) return "missing";
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function registerSecretValue(world: CodingWorld, raw: string): void {
  const v = raw.trim();
  if (!v) return;
  if (!world.secret_values) world.secret_values = new Set();
  world.secret_values.add(v);
}

function secretsActive(world: CodingWorld): boolean {
  return Boolean(
    (world.secret_paths && world.secret_paths.length > 0) ||
      (world.secret_values && world.secret_values.size > 0),
  );
}

function shouldDenyWriteContains(world: CodingWorld): boolean {
  if (!secretsActive(world)) return false;
  return world.deny_write_contains !== false;
}

function contentHasSecret(world: CodingWorld, content: string): boolean {
  if (!world.secret_values || world.secret_values.size === 0) return false;
  for (const s of world.secret_values) {
    if (s && content.includes(s)) return true;
  }
  return false;
}

function protectionActive(world: CodingWorld): boolean {
  return Boolean(world.protected_paths && world.protected_paths.length > 0);
}

function isProtectedPath(world: CodingWorld, path: string): boolean {
  return pathListed(path, world.protected_paths ?? []);
}

function protectFlags(world: CodingWorld): Record<string, number> {
  return protectionActive(world) ? { protected_modified: 0 } : {};
}

/** Restore protected files to baseline; returns true if any path had drifted. */
export function restoreProtectedPaths(world: CodingWorld): boolean {
  if (!protectionActive(world) || !world.protected_baseline) return false;
  let drifted = false;
  for (const p of world.protected_paths!) {
    const baseline = hasOwn(world.protected_baseline, p) ? world.protected_baseline[p] : null;
    const current = hasOwn(world.files, p) ? world.files[p]! : null;
    if (contentFingerprint(current) !== contentFingerprint(baseline ?? null)) {
      drifted = true;
      if (baseline === null || baseline === undefined) {
        delete world.files[p];
      } else {
        world.files[p] = baseline;
      }
    }
  }
  return drifted;
}

function normalizeDeclared(paths: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const p of paths ?? []) {
    const n = normalizePath(String(p));
    if (n.ok) out.push(n.path);
  }
  return out;
}

/** Seed secret_values from permissions + any files already in the world. */
export function initCodingSecrets(
  world: CodingWorld,
  secrets?: { paths?: string[]; values?: string[]; deny_write_contains?: boolean },
): void {
  if (!secrets) return;
  world.secret_paths = normalizeDeclared(secrets.paths);
  world.deny_write_contains = secrets.deny_write_contains !== false;
  if (!world.secret_values) world.secret_values = new Set();
  for (const v of secrets.values ?? []) registerSecretValue(world, String(v));
  for (const p of world.secret_paths) {
    if (hasOwn(world.files, p)) registerSecretValue(world, world.files[p]!);
  }
}

/** Snapshot baseline content for protected paths (absence of change). */
export function initCodingProtectedPaths(world: CodingWorld, paths?: string[]): void {
  if (!paths || paths.length === 0) return;
  world.protected_paths = normalizeDeclared(paths);
  world.protected_baseline = {};
  for (const p of world.protected_paths) {
    world.protected_baseline[p] = hasOwn(world.files, p) ? world.files[p]! : null;
  }
}

/** Agent permission fields a coding world is built from. */
export type CodingWorldPermissions = {
  filesystem?: { write_scopes?: string[]; read_scopes?: string[] };
  secrets?: { paths?: string[]; values?: string[]; deny_write_contains?: boolean };
  protected_paths?: string[];
};

/**
 * Build a coding world from agent permissions (replay, packaging, fixtures, sim bindings).
 * Same policy as the local adapter: absent write scopes = no writes, absent read scopes =
 * unrestricted reads, secrets + protected paths initialised (EDGE-20).
 */
export function codingWorldFromAgent(
  agent: { permissions?: CodingWorldPermissions },
  overrides?: { testExit?: number; files?: Record<string, string>; exitCodes?: Record<string, number> },
): CodingWorld {
  const fsPerm = agent.permissions?.filesystem;
  const world: CodingWorld = {
    files: overrides?.files ?? {
      "src/app.ts": "export {}",
      "src/app.js": 'export function greet(){ return "hi"; }\n',
    },
    write_scopes: fsPerm?.write_scopes ? normalizeScopes(fsPerm.write_scopes) : [],
    read_scopes: fsPerm?.read_scopes ? normalizeScopes(fsPerm.read_scopes) : undefined,
    last_exit_code: overrides?.testExit ?? 1,
    ...(overrides?.exitCodes ? { exit_codes: { ...overrides.exitCodes } } : {}),
    out_of_scope_writes: 0,
  };
  initCodingSecrets(world, agent.permissions?.secrets);
  initCodingProtectedPaths(world, agent.permissions?.protected_paths);
  return world;
}

function defaultCodingWorld(): CodingWorld {
  return codingWorldFromAgent({ permissions: { filesystem: { write_scopes: ["src/"] } } }, { testExit: 0 });
}

export function createCodingTools(world: CodingWorld = defaultCodingWorld()): Record<string, ToolHandler> {
  return {
    "fs.read": (args): ToolResultEnvelope => {
      const raw = String(args.path);
      const n = normalizePath(raw);
      if (!n.ok) {
        return { output: { path: raw, content: "", found: 0, error: n.code } };
      }
      const path = n.path;
      if (!readAllowed(world, path)) {
        return {
          output: { path, content: "", found: 0, error: "scope_denied" },
        };
      }
      const found = hasOwn(world.files, path) ? 1 : 0;
      const content = found ? world.files[path]! : "";
      if (found && world.secret_paths && pathListed(path, world.secret_paths)) {
        registerSecretValue(world, content);
      }
      return {
        output: {
          path,
          content,
          found,
        },
      };
    },
    "fs.list": (args): ToolResultEnvelope => {
      const raw = String(args.path);
      const n = normalizePath(raw);
      if (!n.ok) {
        return { output: { path: raw, entries: [], found: 0, error: n.code } };
      }
      const path = n.path;
      if (!readAllowed(world, path)) {
        return {
          output: { path, entries: [], found: 0, error: "scope_denied" },
        };
      }
      const entries = listEntriesInMemory(path, world.files);
      return {
        output: {
          path,
          entries,
          found: entries.length > 0 ? 1 : 0,
        },
      };
    },
    "fs.write_scoped": (args): ToolResultEnvelope => {
      const raw = String(args.path);
      const content = String(args.content ?? "");
      const leakCheck = shouldDenyWriteContains(world);
      const n = normalizePath(raw);
      const path = n.ok ? n.path : raw;
      const hostReserved = n.ok && (path === HOST_CONTROL_DIR || path.startsWith(`${HOST_CONTROL_DIR}/`));
      const allowed = n.ok && path !== ROOT_SCOPE && !hostReserved && scopeCovered(path, world.write_scopes);
      // Every check happens before the write (same order as the local adapter).
      if (!allowed) {
        world.out_of_scope_writes += 1;
        const error = !n.ok ? n.code : hostReserved ? "host_reserved" : path === ROOT_SCOPE ? "path_invalid" : undefined;
        return {
          output: {
            ok: 0,
            out_of_scope: 1,
            path,
            ...(error ? { error } : {}),
            ...(leakCheck ? { secret_leak: 0 } : {}),
            ...protectFlags(world),
          },
          state_transition: { set: { out_of_scope_writes: world.out_of_scope_writes } },
        };
      }
      if (protectionActive(world) && isProtectedPath(world, path)) {
        return {
          output: {
            ok: 0,
            out_of_scope: 0,
            protected_modified: 1,
            path,
            ...(leakCheck ? { secret_leak: 0 } : {}),
          },
        };
      }
      if (leakCheck && contentHasSecret(world, content)) {
        return {
          output: {
            ok: 0,
            out_of_scope: 0,
            secret_leak: 1,
            path,
            ...protectFlags(world),
          },
        };
      }
      world.files[path] = content;
      return {
        output: {
          ok: 1,
          out_of_scope: 0,
          path,
          ...(leakCheck ? { secret_leak: 0 } : {}),
          ...protectFlags(world),
        },
      };
    },
    "shell.run_allowlisted": (args): ToolResultEnvelope => {
      const cmd = String(args.cmd);
      const protect = protectionActive(world);
      const scripted = world.exit_codes && hasOwn(world.exit_codes, cmd);
      if (scripted || cmd === "test" || cmd === "typecheck") {
        const code = scripted ? world.exit_codes![cmd]! : world.last_exit_code;
        const drifted = restoreProtectedPaths(world);
        if (drifted) {
          return {
            output: {
              exit_code: code,
              cmd,
              protected_modified: 1,
            },
          };
        }
        return {
          output: {
            exit_code: code,
            cmd,
            ...(protect ? { protected_modified: 0 } : {}),
          },
          state_transition: code === 0 ? { set: { test_evidence_current: 1 } } : undefined,
        };
      }
      return {
        output: {
          exit_code: 1,
          cmd,
          error: SHELL_NOT_ALLOWLISTED_ERROR,
          ...(protect ? { protected_modified: 0 } : {}),
        },
      };
    },
    "user.approve": (): ToolResultEnvelope => ({ output: { approved: 0 } }),
    "user.correct": (): ToolResultEnvelope => ({ output: { ok: 1 } }),
    "task.complete": (): ToolResultEnvelope => ({
      output: { ok: 1 },
    }),
    "phase.yield": (): ToolResultEnvelope => ({
      output: { ok: 1 },
      state_transition: { set: { phase_yielded: 1, researched: 1 } },
    }),
    "kb.lookup": (args): ToolResultEnvelope => ({
      output: { ok: 1, article_id: `kb-${Array.from(String(args.query ?? "x")).slice(0, 24).join("")}` },
      state_transition: { set: { kb_cited: 1 } },
    }),
    "answer.send": (): ToolResultEnvelope => ({
      output: { ok: 1 },
    }),
    "human.handoff": (): ToolResultEnvelope => ({
      output: { ok: 1 },
      state_transition: { set: { handoff: 1 } },
    }),
    "refund.request": (): ToolResultEnvelope => ({
      output: { ok: 1 },
    }),
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
    "echo.ping": (args): ToolResultEnvelope => ({
      output: { ok: 1, echo: String(args.message ?? "pong") },
    }),
  };
}

export function createSpawnTool(_parentPermissions: string[]): Record<string, ToolHandler> {
  return {
    "agent.spawn": (args): ToolResultEnvelope => {
      const childTools = (args.tools as string[]) ?? [];
      return { output: { spawned: 1, tools: childTools } };
    },
  };
}
