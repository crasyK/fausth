/**
 * Resolve deployment.bindings → tool handlers.
 * Missing / unknown natives fail as adapter errors (not harness authorize denies).
 *
 * Binding forms:
 *   <tool>: { native: "<host native id>" }        host implementation
 *   <tool>: { user: { source: recorded|simulator|human, ... } }   the User cell (D14)
 * A tool whose IR declares `channel: "user"` may only be bound through `user:`; when it is
 * not bound at all it stays without a handler (the runtime denies it: capability missing).
 */
import { dirname } from "node:path";
import type { ToolHandler } from "../runtime.js";
import type { AgentIR, Deployment, ToolDef } from "../types.js";
import { createGreenhouseTools } from "../tools/world.js";
import { createSpawnTool } from "../tools/world.js";
import { createSimulationWorldForAgent } from "./simulation.js";
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
  disposeLocalWorld,
  pickLocalHandler,
  type LocalWorldExtension,
} from "./local.js";
import {
  createTauWorldTools,
  deploymentUsesTauWorld,
  TAU_NATIVES,
  TAU_WORLD_EXTENSION,
} from "./worlds/tau.js";
import { bundleProvenanceFor } from "./provenance.js";
import { spawnPolicyFromEnv, type SpawnPolicy } from "./stdio-session.js";
import {
  createUserChannelHandler,
  isUserChannelBinding,
  parseUserChannelBinding,
  type UserChannelOptions,
} from "./user-channel.js";
import type { ResolvedHarnessIR } from "../types.js";

export { AdapterError } from "./error.js";
export type { AdapterErrorCode } from "./error.js";
export { deploymentUsesModule, parseModuleNative } from "./module.js";
export { closeAllHostSessions } from "./stdio-session.js";

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
  "stub.approve": "user.approve",
  "sim.approve": "user.approve",
  "local.user_approve": "user.approve",
  "local.user_approve_auto": "user.approve",
  "user.approve": "user.approve",
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

/**
 * Natives removed because they answered the user cell from the acting model's own args
 * (D14). Kept as a closed list only to produce an actionable error.
 */
const REMOVED_USER_NATIVES = new Set(["stub.ask", "user.ask", "local.user_ask", "local.user_ask_auto"]);

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
  /**
   * Path of the deployment file the bindings came from. Used for provenance checks
   * (a deployment shipped inside a bundle may not spawn host commands on its own) and as
   * the base directory for user-channel files. When omitted, `harnessDir` is used.
   */
  deploymentPath?: string;
  /** Operator allow for bundle-declared commands (default: FAUSTH_ALLOW_COMMANDS env). */
  spawnPolicy?: Omit<SpawnPolicy, "provenance">;
  /** User channel host hooks (transcript sink, human callback, simulator transport). */
  userChannel?: Pick<UserChannelOptions, "transcript" | "humanAnswer" | "simulatorPort">;
  /** Host-approved plan write paths for local worlds. */
  approvedWritePaths?: string[];
};

/** Bound handlers plus a cleanup that terminates any host sessions (stdio children). */
export type BoundTools = {
  tools: Record<string, ToolHandler>;
  cleanup: () => void;
};

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function buildHandlerPool(agent: AgentIR, opts: ResolveToolsOptions = {}): Record<string, ToolHandler> {
  const { tools: coding } = createSimulationWorldForAgent(agent, {
    files: opts.files,
    testExit: opts.testExit,
  });
  const greenhouse = createGreenhouseTools({
    temperature_decidegrees: Number(agent.state.temperature_decidegrees ?? 250),
    fan_percent: Number(agent.state.fan_percent ?? 0),
    sensor_healthy: opts.sensorHealthy ?? Number(agent.state.sensor_healthy ?? 1),
  });
  const spawn = createSpawnTool(agent.permissions?.tools ?? []);
  return { ...greenhouse, ...coding, ...spawn };
}

/** IR channel declaration (types.ts gains `channel` via the contract WP; read it loosely). */
function toolChannel(tool: ToolDef): string | undefined {
  const ch = (tool as ToolDef & { channel?: unknown }).channel;
  return typeof ch === "string" ? ch : undefined;
}

function allowSetKeysFor(agent: AgentIR, toolId: string): string[] {
  const keys = new Set<string>();
  for (const cp of agent.counterbalance?.checkpoints ?? []) {
    if (cp.tool === toolId) for (const k of cp.allow_set_keys ?? []) keys.add(k);
  }
  return [...keys].sort();
}

/**
 * For each agent tool, require a deployment binding whose native resolves to that tool.
 * Prefer {@link bindToolsFromDeployment}, which also returns the session cleanup.
 */
export function resolveToolsFromDeployment(
  agent: AgentIR,
  deployment: Deployment,
  opts: ResolveToolsOptions = {},
): Record<string, ToolHandler> {
  return bindToolsFromDeployment(agent, deployment, opts).tools;
}

/**
 * Bind deployment natives to handlers and return a cleanup that closes any host
 * sessions (MCP/module stdio children, local world temp dirs). Callers must invoke
 * cleanup when the run ends (process exit also reaps stdio children).
 */
export function bindToolsFromDeployment(
  agent: AgentIR,
  deployment: Deployment,
  opts: ResolveToolsOptions = {},
): BoundTools {
  const cleanups: Array<() => void> = [];
  const cleanup = () => {
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch {
        /* best-effort */
      }
    }
  };
  try {
    return { tools: bindToolsInner(agent, deployment, opts, cleanups), cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function bindToolsInner(
  agent: AgentIR,
  deployment: Deployment,
  opts: ResolveToolsOptions,
  cleanups: Array<() => void>,
): Record<string, ToolHandler> {
  assertBindingFamilyConsistency(deployment);
  const usesLocal = deploymentUsesLocal(deployment);
  if (usesLocal && deploymentUsesMcp(deployment)) {
    throw new AdapterError(
      "adapter_unresolved",
      "deployment mixes local.* bindings with mcp.* — use a single binding family",
    );
  }
  if (usesLocal && deploymentUsesModule(deployment)) {
    throw new AdapterError(
      "adapter_unresolved",
      "deployment mixes local.* bindings with module.* — use a single binding family",
    );
  }

  const provenance = bundleProvenanceFor(opts.deploymentPath ?? opts.harnessDir ?? "");
  const spawnPolicy: SpawnPolicy = { ...(opts.spawnPolicy ?? spawnPolicyFromEnv()), provenance };

  let pool: Record<string, ToolHandler>;
  let localNatives: Record<string, ToolHandler> = {};
  let mcpNativeToTool: Record<string, string> = {};
  let moduleNativeToTool: Record<string, string> = {};
  const nativeToTool: Record<string, string> = { ...NATIVE_TO_TOOL };
  if (usesLocal) {
    if (!opts.workspace) {
      throw new AdapterError(
        "adapter_unresolved",
        "adapter failure: local.* bindings require --workspace (linked disposable worktree)",
      );
    }
    const tau = deploymentUsesTauWorld(deployment);
    const extensions: LocalWorldExtension[] = tau ? [TAU_WORLD_EXTENSION] : [];
    const world = createLocalWorld({
      workspace: opts.workspace,
      agent,
      deployment,
      interactive: opts.interactive,
      approvedWritePaths: opts.approvedWritePaths,
      extensions,
    });
    cleanups.push(() => disposeLocalWorld(world));
    const localTools = createLocalCodingTools(world);
    if (tau) {
      localNatives = createTauWorldTools(world);
      Object.assign(nativeToTool, TAU_NATIVES);
    }
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
        spawnPolicy,
      });
      cleanups.push(mcp.cleanup);
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
      const mod = createModuleHandlers(deployment, { harnessDir: opts.harnessDir, spawnPolicy });
      cleanups.push(mod.cleanup);
      pool = { ...pool, ...mod.handlers };
      moduleNativeToTool = mod.nativeToTool;
    }
  }

  const bindings = (deployment.bindings ?? {}) as Record<string, unknown>;
  const out: Record<string, ToolHandler> = {};
  const userBaseDir = opts.deploymentPath ? dirname(opts.deploymentPath) : opts.harnessDir;

  for (const tool of agent.tools) {
    const id = tool.id;
    const binding = hasOwn(bindings, id) ? bindings[id] : undefined;
    const channel = toolChannel(tool);

    if (isUserChannelBinding(binding)) {
      if (typeof (binding as Record<string, unknown>).native === "string") {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: binding for '${id}' declares both native and user (adapter_unresolved)`,
        );
      }
      const parsed = parseUserChannelBinding(id, binding.user);
      if (parsed.source !== "human" && !userBaseDir) {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: user channel for '${id}' needs a deployment path or harness directory`,
        );
      }
      out[id] = createUserChannelHandler(tool, parsed, {
        baseDir: userBaseDir ?? process.cwd(),
        deployment,
        allowSetKeys: allowSetKeysFor(agent, id),
        ...(opts.userChannel ?? {}),
      });
      continue;
    }

    if (channel === "user") {
      if (binding !== undefined) {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: tool '${id}' declares channel user; bind it with user: {source: recorded|simulator|human}`,
        );
      }
      continue; // unbound user channel → no handler → runtime denies (capability missing)
    }

    const native =
      binding && typeof binding === "object" && typeof (binding as { native?: unknown }).native === "string"
        ? ((binding as { native: string }).native)
        : "";
    if (!native) {
      throw new AdapterError(
        "binding_missing",
        `adapter failure: no deployment binding for tool '${id}' (binding_missing)`,
      );
    }
    if (REMOVED_USER_NATIVES.has(native)) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: native '${native}' was removed — it answered the user from the model's own args (D14); bind '${id}' with user: {source: recorded|simulator|human} (adapter_unresolved)`,
      );
    }
    let mapped =
      (hasOwn(nativeToTool, native) ? nativeToTool[native] : undefined) ??
      (hasOwn(mcpNativeToTool, native) ? mcpNativeToTool[native] : undefined) ??
      (hasOwn(moduleNativeToTool, native) ? moduleNativeToTool[native] : undefined);
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
    const handler = hasOwn(localNatives, native)
      ? localNatives[native]
      : usesLocal
        ? pickLocalHandler(pool, id, native)
        : hasOwn(pool, id)
          ? pool[id]
          : undefined;
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
