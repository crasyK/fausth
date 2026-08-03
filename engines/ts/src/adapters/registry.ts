/**
 * Resolve deployment.bindings → tool handlers.
 * Missing / unknown natives fail as adapter errors (not harness authorize denies).
 */
import type { ToolHandler } from "../runtime.js";
import type { AgentIR, Deployment } from "../types.js";
import { createGreenhouseTools } from "../tools/world.js";
import { createSpawnTool } from "../tools/world.js";
import { createSimulationCodingAdapter } from "./simulation.js";
import { AdapterError } from "./error.js";
import {
  createMcpHandlers,
  deploymentUsesMcp,
  mcpToolMapFromResolved,
  parseMcpNative,
} from "./mcp.js";
import {
  createModuleHandlers,
  deploymentUsesModule,
  parseModuleNative,
} from "./module.js";
import {
  assertBindingFamilyConsistency,
  createLocalCodingTools,
  createLocalWorld,
  deploymentUsesLocal,
  pickLocalHandler,
} from "./local.js";
import type { ResolvedHarnessIR } from "../types.js";

export { AdapterError } from "./error.js";
export type { AdapterErrorCode } from "./error.js";
export { deploymentUsesModule, parseModuleNative } from "./module.js";

/** Map deployment `native:` id → harness tool id. */
export const NATIVE_TO_TOOL: Record<string, string> = {
  "stub.fs_read": "fs.read",
  "sim.fs_read": "fs.read",
  "local.fs_read": "fs.read",
  "fs.read": "fs.read",
  "stub.fs_list": "fs.list",
  "sim.fs_list": "fs.list",
  "local.fs_list": "fs.list",
  "fs.list": "fs.list",
  "stub.fs_write": "fs.write_scoped",
  "sim.fs_write": "fs.write_scoped",
  "local.fs_write": "fs.write_scoped",
  "fs.write_scoped": "fs.write_scoped",
  "stub.shell": "shell.run_allowlisted",
  "sim.shell": "shell.run_allowlisted",
  "local.shell": "shell.run_allowlisted",
  "shell.run_allowlisted": "shell.run_allowlisted",
  "local.tau_invoke": "tau.invoke",
  "tau.invoke": "tau.invoke",
  "local.todo_complete": "todo.complete",
  "todo.complete": "todo.complete",
  "stub.approve": "user.approve",
  "sim.approve": "user.approve",
  "local.user_approve": "user.approve",
  "local.user_approve_auto": "user.approve",
  "user.approve": "user.approve",
  "stub.ask": "user.ask",
  "user.ask": "user.ask",
  "local.user_ask": "user.ask",
  "local.user_ask_auto": "user.ask",
  "stub.user_correct": "user.correct",
  "sim.user_correct": "user.correct",
  "local.user_correct": "user.correct",
  "local.user_correct_auto": "user.correct",
  "user.correct": "user.correct",
  "stub.task_complete": "task.complete",
  "sim.task_complete": "task.complete",
  "local.task_complete": "task.complete",
  "task.complete": "task.complete",
  "stub.phase_yield": "phase.yield",
  "sim.phase_yield": "phase.yield",
  "local.phase_yield": "phase.yield",
  "phase.yield": "phase.yield",
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
  "stub.harness_patch": "harness.propose_skills_patch",
  "sim.harness_patch": "harness.propose_skills_patch",
  "harness.propose_skills_patch": "harness.propose_skills_patch",
  "stub.harness_decline": "harness.decline_skills_patch",
  "sim.harness_decline": "harness.decline_skills_patch",
  "local.harness_decline": "harness.decline_skills_patch",
  "harness.decline_skills_patch": "harness.decline_skills_patch",
  "stub.harness_reflect": "harness.reflect_skills",
  "sim.harness_reflect": "harness.reflect_skills",
  "local.harness_reflect": "harness.reflect_skills",
  "harness.reflect_skills": "harness.reflect_skills",
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
  /** Required when deployment uses local.* bindings. */
  workspace?: string;
  /** Force interactive checkpoints off (non-TTY). */
  interactive?: boolean;
  /** Required when deployment uses mcp.* recorded paths. */
  harnessDir?: string;
  /** Resolved IR for mcp_tool name maps (optional). */
  resolved?: ResolvedHarnessIR;
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
    coding["shell.run_allowlisted"] = (args) => {
      const cmd = String(args.cmd);
      if (cmd === "test" || cmd === "typecheck") {
        return { output: { exit_code: opts.testExit!, cmd } };
      }
      return { output: { exit_code: 1, cmd, error: "not allowlisted: only 'test' and 'typecheck' are available; use fs.read/fs.list to explore" } };
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
  assertBindingFamilyConsistency(deployment);
  if (deploymentUsesLocal(deployment) && deploymentUsesMcp(deployment)) {
    throw new AdapterError(
      "adapter_unresolved",
      "deployment mixes local.* bindings with mcp.* — use a single binding family",
    );
  }
  if (deploymentUsesLocal(deployment) && deploymentUsesModule(deployment)) {
    throw new AdapterError(
      "adapter_unresolved",
      "deployment mixes local.* bindings with module.* — use a single binding family",
    );
  }

  let pool: Record<string, ToolHandler>;
  let mcpNativeToTool: Record<string, string> = {};
  let moduleNativeToTool: Record<string, string> = {};
  if (deploymentUsesLocal(deployment)) {
    if (!opts.workspace) {
      throw new AdapterError(
        "adapter_unresolved",
        "adapter failure: local.* bindings require --workspace (linked disposable worktree)",
      );
    }
    const world = createLocalWorld({
      workspace: opts.workspace,
      agent,
      deployment,
      interactive: opts.interactive,
    });
    const localTools = createLocalCodingTools(world);
    const greenhouse = createGreenhouseTools({
      temperature_decidegrees: Number(agent.state.temperature_decidegrees ?? 250),
      fan_percent: Number(agent.state.fan_percent ?? 0),
      sensor_healthy: opts.sensorHealthy ?? Number(agent.state.sensor_healthy ?? 1),
    });
    const spawn = createSpawnTool(agent.permissions?.tools ?? []);
    pool = { ...greenhouse, ...localTools, ...spawn };
  } else {
    pool = buildHandlerPool(agent, opts);
    if (deploymentUsesMcp(deployment)) {
      if (!opts.harnessDir) {
        throw new AdapterError(
          "adapter_unresolved",
          "adapter failure: mcp.* bindings require harness directory context",
        );
      }
      const mcp = createMcpHandlers(deployment, {
        harnessDir: opts.harnessDir,
        mcpToolMap: mcpToolMapFromResolved(opts.resolved),
      });
      pool = { ...pool, ...mcp.handlers };
      mcpNativeToTool = mcp.nativeToTool;
    }
    if (deploymentUsesModule(deployment)) {
      if (!opts.harnessDir) {
        throw new AdapterError(
          "adapter_unresolved",
          "adapter failure: module.* bindings require harness directory context",
        );
      }
      const mod = createModuleHandlers(deployment, { harnessDir: opts.harnessDir });
      pool = { ...pool, ...mod.handlers };
      moduleNativeToTool = mod.nativeToTool;
    }
  }

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
    const native = binding.native;
    let mapped = NATIVE_TO_TOOL[native] ?? mcpNativeToTool[native] ?? moduleNativeToTool[native];
    if (!mapped && native.startsWith("mcp.")) {
      const parsed = parseMcpNative(native);
      if (parsed && parsed.toolId === id) mapped = id;
    }
    if (!mapped && native.startsWith("module.")) {
      const parsed = parseModuleNative(native);
      if (parsed && parsed.toolId === id) mapped = id;
    }
    if (!mapped) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: unknown native '${native}' for tool '${id}' (adapter_unresolved)`,
      );
    }
    if (mapped !== id) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: native '${native}' maps to '${mapped}', not '${id}' (adapter_unresolved)`,
      );
    }
    const handler =
      deploymentUsesLocal(deployment)
        ? pickLocalHandler(pool, id, native)
        : pool[id];
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
