/**
 * Resolve deployment.bindings → tool handlers.
 * Missing / unknown natives fail as adapter errors (not harness authorize denies).
 */
import type { ToolHandler } from "../runtime.js";
import type { AgentIR, Deployment } from "../types.js";
import { createGreenhouseTools } from "../tools/world.js";
import { createSpawnTool } from "../tools/world.js";
import { createSimulationCodingAdapter } from "./simulation.js";

export type AdapterErrorCode = "binding_missing" | "adapter_unresolved";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/** Map deployment `native:` id → harness tool id. */
export const NATIVE_TO_TOOL: Record<string, string> = {
  "stub.fs_read": "fs.read",
  "sim.fs_read": "fs.read",
  "fs.read": "fs.read",
  "stub.fs_write": "fs.write_scoped",
  "sim.fs_write": "fs.write_scoped",
  "fs.write_scoped": "fs.write_scoped",
  "stub.shell": "shell.run_allowlisted",
  "sim.shell": "shell.run_allowlisted",
  "shell.run_allowlisted": "shell.run_allowlisted",
  "stub.approve": "user.approve",
  "sim.approve": "user.approve",
  "user.approve": "user.approve",
  "stub.ask": "user.ask",
  "user.ask": "user.ask",
  "stub.user_correct": "user.correct",
  "sim.user_correct": "user.correct",
  "user.correct": "user.correct",
  "stub.mode_enter": "mode.enter",
  "sim.mode_enter": "mode.enter",
  "mode.enter": "mode.enter",
  "stub.task_complete": "task.complete",
  "sim.task_complete": "task.complete",
  "task.complete": "task.complete",
  "stub.kb_lookup": "kb.lookup",
  "sim.kb_lookup": "kb.lookup",
  "kb.lookup": "kb.lookup",
  "stub.answer_send": "answer.send",
  "sim.answer_send": "answer.send",
  "answer.send": "answer.send",
  "stub.human_handoff": "human.handoff",
  "sim.human_handoff": "human.handoff",
  "human.handoff": "human.handoff",
  "stub.refund_request": "refund.request",
  "refund.request": "refund.request",
  "stub.spawn": "agent.spawn",
  "agent.spawn": "agent.spawn",
  "stub.temperature": "sensor.temperature.read",
  "sensor.temperature.read": "sensor.temperature.read",
  "stub.fan_read": "sensor.fan.read_percent",
  "sensor.fan.read_percent": "sensor.fan.read_percent",
  "stub.fan_set": "actuator.fan.set",
  "actuator.fan.set": "actuator.fan.set",
  "stub.wait": "system.wait",
  "system.wait": "system.wait",
};

export type ResolveToolsOptions = {
  testExit?: number;
  sensorHealthy?: number;
  files?: Record<string, string>;
};

function buildHandlerPool(agent: AgentIR, opts: ResolveToolsOptions = {}): Record<string, ToolHandler> {
  const writeScopes = agent.permissions?.filesystem?.write_scopes ?? ["src/"];
  const { tools: coding } = createSimulationCodingAdapter({
    files: opts.files,
    write_scopes: writeScopes,
    exit_codes:
      opts.testExit !== undefined
        ? { test: opts.testExit, typecheck: opts.testExit }
        : undefined,
  });
  if (opts.testExit !== undefined) {
    // ensure coding world last_exit_code matches when shell falls through
    coding["shell.run_allowlisted"] = (args) => {
      const cmd = String(args.cmd);
      if (cmd === "test" || cmd === "typecheck") {
        return { output: { exit_code: opts.testExit!, cmd } };
      }
      return { output: { exit_code: 1, cmd, error: "not allowlisted" } };
    };
  }
  const greenhouse = createGreenhouseTools({
    temperature_decidegrees: Number(agent.state.temperature_decidegrees ?? 250),
    fan_percent: Number(agent.state.fan_percent ?? 0),
    sensor_healthy: opts.sensorHealthy ?? Number(agent.state.sensor_healthy ?? 1),
  });
  const spawn = createSpawnTool(agent.permissions?.tools ?? []);
  return { ...greenhouse, ...coding, ...spawn };
}

/**
 * For each agent tool, require a deployment binding whose native resolves to that tool.
 */
export function resolveToolsFromDeployment(
  agent: AgentIR,
  deployment: Deployment,
  opts: ResolveToolsOptions = {},
): Record<string, ToolHandler> {
  const pool = buildHandlerPool(agent, opts);
  const bindings = deployment.bindings ?? {};
  const out: Record<string, ToolHandler> = {};

  for (const tool of agent.tools) {
    const id = tool.id;
    const binding = bindings[id];
    if (!binding || typeof binding.native !== "string" || !binding.native) {
      throw new AdapterError(
        "binding_missing",
        `adapter failure: no deployment binding for tool '${id}' (binding_missing)`,
      );
    }
    const mapped = NATIVE_TO_TOOL[binding.native];
    if (!mapped) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: unknown native '${binding.native}' for tool '${id}' (adapter_unresolved)`,
      );
    }
    if (mapped !== id) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: native '${binding.native}' maps to '${mapped}', not '${id}' (adapter_unresolved)`,
      );
    }
    const handler = pool[id];
    if (!handler) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: no host handler for tool '${id}' (adapter_unresolved)`,
      );
    }
    out[id] = handler;
  }

  return out;
}
