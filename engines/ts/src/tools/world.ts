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
  last_exit_code: number;
  out_of_scope_writes: number;
};

export function createCodingTools(world: CodingWorld): Record<string, ToolHandler> {
  return {
    "fs.read": (args): ToolResultEnvelope => {
      const path = String(args.path);
      return {
        output: {
          path,
          content: world.files[path] ?? "",
          found: world.files[path] !== undefined ? 1 : 0,
        },
      };
    },
    "fs.write_scoped": (args): ToolResultEnvelope => {
      const path = String(args.path);
      const content = String(args.content ?? "");
      const allowed = world.write_scopes.some(
        (s) => path === s || path.startsWith(s.endsWith("/") ? s : s + "/"),
      );
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
      return { output: { exit_code: 1, cmd, error: "not allowlisted" } };
    },
    "user.approve": (): ToolResultEnvelope => ({ output: { approved: 0 } }),
    "user.ask": (): ToolResultEnvelope => ({ output: { answer: "" } }),
    "user.correct": (): ToolResultEnvelope => ({ output: { ok: 1 } }),
    "mode.enter": (args): ToolResultEnvelope => {
      const mode = String(args.mode ?? "");
      return {
        output: { ok: 1, mode },
        state_transition: { set: { mode } },
      };
    },
    "task.complete": (): ToolResultEnvelope => ({
      output: { ok: 1 },
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
      state_transition: { set: { handoff: 1, mode: "handoff" } },
    }),
    "refund.request": (): ToolResultEnvelope => ({
      output: { ok: 1 },
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
