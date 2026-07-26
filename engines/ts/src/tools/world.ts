import type { ToolHandler } from "../runtime.js";

/** In-memory greenhouse world for stubs + fixtures. */
export type GreenhouseWorld = {
  temperature_decidegrees: number;
  fan_percent: number;
  sensor_healthy: number; // 1 | 0
};

export function createGreenhouseTools(world: GreenhouseWorld): Record<string, ToolHandler> {
  return {
    "sensor.temperature.read": () => ({
      celsius_decidegrees: world.temperature_decidegrees,
    }),
    "sensor.fan.read_percent": () => ({
      percent: world.fan_percent,
    }),
    "actuator.fan.set": (args) => {
      const percent = Number(args.percent);
      world.fan_percent = percent;
      return {
        ok: 1,
        percent,
        _state_patch: { fan_percent: percent },
      };
    },
    "system.wait": (args) => ({ waited_ms: Number(args.ms ?? 0) }),
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
    "fs.read": (args) => {
      const path = String(args.path);
      return { path, content: world.files[path] ?? "", found: world.files[path] !== undefined ? 1 : 0 };
    },
    "fs.write_scoped": (args) => {
      const path = String(args.path);
      const content = String(args.content ?? "");
      const allowed = world.write_scopes.some(
        (s) => path === s || path.startsWith(s.endsWith("/") ? s : s + "/"),
      );
      if (!allowed) {
        world.out_of_scope_writes += 1;
        return { ok: 0, out_of_scope: 1, path };
      }
      world.files[path] = content;
      return { ok: 1, out_of_scope: 0, path };
    },
    "shell.run_allowlisted": (args) => {
      const cmd = String(args.cmd);
      // stub: "test" and "typecheck" use world.last_exit_code
      if (cmd === "test" || cmd === "typecheck") {
        return { exit_code: world.last_exit_code, cmd };
      }
      return { exit_code: 1, cmd, error: "not allowlisted" };
    },
    "user.approve": () => ({ approved: 0 }),
    "user.ask": () => ({ answer: "" }),
  };
}

export function createSpawnTool(parentPermissions: string[]): Record<string, ToolHandler> {
  return {
    "agent.spawn": (args) => {
      const childTools = (args.tools as string[]) ?? [];
      const escalate = childTools.some((t) => !parentPermissions.includes(t));
      if (escalate) {
        throw new Error("spawn escalate denied");
      }
      return { spawned: 1, tools: childTools };
    },
  };
}
