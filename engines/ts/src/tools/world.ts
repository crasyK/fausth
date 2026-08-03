import { createHash } from "node:crypto";
import type { ToolHandler } from "../runtime.js";
import type { ToolResultEnvelope } from "../types.js";

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
  write_scopes: string[];
  read_scopes?: string[];
  last_exit_code: number;
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

const SHELL_NOT_ALLOWLISTED_ERROR =
  "not allowlisted: only 'test' and 'typecheck' are available; use fs.read/fs.list to explore";

function listEntriesInMemory(path: string, files: Record<string, string>): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const prefix = normalized ? `${normalized}/` : "";
  const entries = new Set<string>();
  for (const key of Object.keys(files)) {
    if (normalized && key !== normalized && !key.startsWith(prefix)) continue;
    if (!normalized) {
      const name = key.split("/")[0];
      if (name) entries.add(name);
      continue;
    }
    const rest = key.slice(prefix.length);
    const name = rest.split("/")[0];
    if (name) entries.add(name);
  }
  return [...entries].sort();
}

function inScope(path: string, scopes: string[]): boolean {
  return scopes.some((s) => {
    if (s === "." || s === "./" || s === "*" || s === "**") return true;
    return path === s || path.startsWith(s.endsWith("/") ? s : s + "/");
  });
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
  return Boolean(world.protected_paths?.includes(path));
}

function protectFlags(world: CodingWorld): Record<string, number> {
  return protectionActive(world) ? { protected_modified: 0 } : {};
}

/** Restore protected files to baseline; returns true if any path had drifted. */
export function restoreProtectedPaths(world: CodingWorld): boolean {
  if (!protectionActive(world) || !world.protected_baseline) return false;
  let drifted = false;
  for (const p of world.protected_paths!) {
    const baseline = world.protected_baseline[p];
    const current = world.files[p] !== undefined ? world.files[p]! : null;
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

/** Seed secret_values from permissions + any files already in the world. */
export function initCodingSecrets(
  world: CodingWorld,
  secrets?: { paths?: string[]; values?: string[]; deny_write_contains?: boolean },
): void {
  if (!secrets) return;
  world.secret_paths = [...(secrets.paths ?? [])];
  world.deny_write_contains = secrets.deny_write_contains !== false;
  if (!world.secret_values) world.secret_values = new Set();
  for (const v of secrets.values ?? []) registerSecretValue(world, String(v));
  for (const p of world.secret_paths) {
    if (world.files[p] !== undefined) registerSecretValue(world, world.files[p]!);
  }
}

/** Snapshot baseline content for protected paths (absence of change). */
export function initCodingProtectedPaths(world: CodingWorld, paths?: string[]): void {
  if (!paths || paths.length === 0) return;
  world.protected_paths = [...paths];
  world.protected_baseline = {};
  for (const p of paths) {
    world.protected_baseline[p] = world.files[p] !== undefined ? world.files[p]! : null;
  }
}

/** Build a coding world from agent permissions (replay, packaging, fixtures). */
export function codingWorldFromAgent(
  agent: { permissions?: CodingWorld["permissions"] & { secrets?: { paths?: string[]; values?: string[]; deny_write_contains?: boolean }; protected_paths?: string[] } },
  overrides?: { testExit?: number; files?: Record<string, string> },
): CodingWorld {
  const world: CodingWorld = {
    files: overrides?.files ?? {
      "src/app.ts": "export {}",
      "src/app.js": 'export function greet(){ return "hi"; }\n',
    },
    write_scopes: agent.permissions?.filesystem?.write_scopes ?? ["src/"],
    read_scopes: agent.permissions?.filesystem?.read_scopes,
    last_exit_code: overrides?.testExit ?? 1,
    out_of_scope_writes: 0,
  };
  initCodingSecrets(world, agent.permissions?.secrets);
  initCodingProtectedPaths(world, agent.permissions?.protected_paths);
  return world;
}

export function createCodingTools(world: CodingWorld): Record<string, ToolHandler> {
  return {
    "fs.read": (args): ToolResultEnvelope => {
      const path = String(args.path);
      const readScopes = world.read_scopes ?? world.write_scopes;
      if (readScopes.length > 0 && !inScope(path, readScopes)) {
        return {
          output: { path, content: "", found: 0, error: "scope_denied" },
        };
      }
      const content = world.files[path] ?? "";
      const found = world.files[path] !== undefined ? 1 : 0;
      if (found && world.secret_paths?.includes(path)) {
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
      const path = String(args.path);
      const readScopes = world.read_scopes ?? world.write_scopes;
      if (readScopes.length > 0 && !inScope(path, readScopes)) {
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
      const path = String(args.path);
      const content = String(args.content ?? "");
      const allowed = inScope(path, world.write_scopes);
      const leakCheck = shouldDenyWriteContains(world);
      if (!allowed) {
        world.out_of_scope_writes += 1;
        return {
          output: {
            ok: 0,
            out_of_scope: 1,
            path,
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
      if (cmd === "test" || cmd === "typecheck") {
        const code = world.last_exit_code;
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
    "user.ask": (args): ToolResultEnvelope => ({
      output: { answer: String(args.answer ?? args.question ?? "") },
      state_transition: { set: { clarified: 1 } },
    }),
    "user.correct": (): ToolResultEnvelope => ({ output: { ok: 1 } }),
    "task.complete": (): ToolResultEnvelope => ({
      output: { ok: 1 },
    }),
    "phase.yield": (): ToolResultEnvelope => ({
      output: { ok: 1 },
      state_transition: { set: { phase_yielded: 1, researched: 1 } },
    }),
    "kb.lookup": (args): ToolResultEnvelope => ({
      output: { ok: 1, article_id: `kb-${String(args.query ?? "x").slice(0, 24)}` },
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
