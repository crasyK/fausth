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
  return scopes.some((s) => path === s || path.startsWith(s.endsWith("/") ? s : s + "/"));
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
      return {
        output: {
          path,
          content: world.files[path] ?? "",
          found: world.files[path] !== undefined ? 1 : 0,
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
      if (!allowed) {
        world.out_of_scope_writes += 1;
        return {
          output: { ok: 0, out_of_scope: 1, path },
          state_transition: { set: { out_of_scope_writes: world.out_of_scope_writes } },
        };
      }
      world.files[path] = content;
      return { output: { ok: 1, out_of_scope: 0, path } };
    },
    "shell.run_allowlisted": (args): ToolResultEnvelope => {
      const cmd = String(args.cmd);
      if (cmd === "test" || cmd === "typecheck") {
        const code = world.last_exit_code;
        return {
          output: { exit_code: code, cmd },
          state_transition: code === 0 ? { set: { test_evidence_current: 1 } } : undefined,
        };
      }
      return { output: { exit_code: 1, cmd, error: SHELL_NOT_ALLOWLISTED_ERROR } };
    },
    "user.approve": (): ToolResultEnvelope => ({ output: { approved: 0 } }),
    "user.ask": (): ToolResultEnvelope => ({ output: { answer: "" } }),
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
