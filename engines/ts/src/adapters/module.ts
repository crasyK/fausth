/**
 * Module host adapters (M17): recorded (Track A) and stdio (live) transports.
 * Resolve stays offline; these run only at bind/execute time.
 * Protocol (stdio): one JSON line request `{tool, args}` → one JSON line `{output}` or `{error}`.
 * Session plumbing is shared with MCP (stdio-session.ts): calls are serialized (the protocol
 * has no ids), a timed-out session is torn down so late replies cannot leak into the next
 * call, spawn failures surface as adapter errors instead of crashing the host.
 */
import type { ToolHandler } from "../runtime.js";
import type { Deployment, DeploymentModuleServer } from "../types.js";
import { AdapterError } from "./error.js";
import { assertNoSecretEnvNames, ChildEnvError } from "./child-process.js";
import {
  assertSpawnAllowed,
  loadRecordedEntries,
  matchRecordedExact,
  ModuleStdioSession,
  type RecordedEntry,
  type SpawnPolicy,
} from "./stdio-session.js";

export function parseModuleNative(
  native: string,
): { serverId: string; toolId: string } | null {
  if (!native.startsWith("module.")) return null;
  const rest = native.slice("module.".length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { serverId: rest.slice(0, dot), toolId: rest.slice(dot + 1) };
}

export function deploymentUsesModule(deployment: Deployment): boolean {
  return Object.values(deployment.bindings ?? {}).some(
    (b) => typeof b.native === "string" && b.native.startsWith("module."),
  );
}

type ModuleServerConfig = DeploymentModuleServer;

/**
 * Build handlers for module.* natives. Sessions are created lazily per server; `cleanup`
 * terminates them (callers must invoke it; process exit also reaps them).
 */
export function createModuleHandlers(
  deployment: Deployment,
  opts: { harnessDir: string; spawnPolicy?: SpawnPolicy },
): {
  handlers: Record<string, ToolHandler>;
  nativeToTool: Record<string, string>;
  cleanup: () => void;
} {
  const handlers: Record<string, ToolHandler> = {};
  const nativeToTool: Record<string, string> = {};
  const sessions = new Map<string, ModuleStdioSession>();
  const recordedUsed = new Map<string, Set<number>>();
  const recordedCache = new Map<string, RecordedEntry[]>();
  const moduleCfg = deployment.module ?? {};

  for (const [toolId, binding] of Object.entries(deployment.bindings ?? {})) {
    const native = binding.native;
    if (typeof native !== "string") continue;
    const parsed = parseModuleNative(native);
    if (!parsed) continue;
    if (parsed.toolId !== toolId) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: module native '${native}' tool id must match binding key '${toolId}'`,
      );
    }
    nativeToTool[native] = toolId;
    const cfg = Object.prototype.hasOwnProperty.call(moduleCfg, parsed.serverId)
      ? (moduleCfg[parsed.serverId] as ModuleServerConfig)
      : undefined;
    if (!cfg) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: no deployment.module.${parsed.serverId} for native '${native}'`,
      );
    }

    if (cfg.transport === "recorded") {
      if (!cfg.recorded) {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: module.${parsed.serverId} recorded transport requires recorded path`,
        );
      }
      const recPath = cfg.recorded;
      handlers[toolId] = (args) => {
        if (!recordedCache.has(parsed.serverId)) {
          recordedCache.set(parsed.serverId, loadRecordedEntries(opts.harnessDir, recPath, "module"));
          recordedUsed.set(parsed.serverId, new Set());
        }
        const entries = recordedCache.get(parsed.serverId)!;
        const used = recordedUsed.get(parsed.serverId)!;
        const result = matchRecordedExact(entries, toolId, args, used, "module");
        if ("output" in result && result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
          return result as { output: Record<string, unknown> };
        }
        return { output: result };
      };
      continue;
    }

    if (cfg.transport === "stdio") {
      if (!cfg.command || typeof cfg.command !== "string") {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: module.${parsed.serverId} stdio transport requires command`,
        );
      }
      if (cfg.env !== undefined && (!cfg.env || typeof cfg.env !== "object" || Array.isArray(cfg.env))) {
        throw new AdapterError("adapter_unresolved", `adapter failure: module.${parsed.serverId} env must be an object`);
      }
      if (cfg.env_passthrough !== undefined && !Array.isArray(cfg.env_passthrough)) {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: module.${parsed.serverId} env_passthrough must be a list of names`,
        );
      }
      try {
        assertNoSecretEnvNames([...Object.keys(cfg.env ?? {}), ...(cfg.env_passthrough ?? [])], "module");
      } catch (e) {
        if (e instanceof ChildEnvError) throw new AdapterError("adapter_unresolved", `adapter failure: ${e.message}`);
        throw e;
      }
      const command = cfg.command;
      const args = cfg.args ?? [];
      const timeoutMs = cfg.timeout_ms ?? 15_000;
      handlers[toolId] = async (callArgs) => {
        let session = sessions.get(parsed.serverId);
        if (session?.closed) {
          sessions.delete(parsed.serverId);
          session = undefined;
        }
        if (!session) {
          assertSpawnAllowed(command, opts.spawnPolicy, "module stdio");
          try {
            session = new ModuleStdioSession(
              {
                command,
                args,
                env: cfg.env,
                envPassthrough: cfg.env_passthrough,
                cwd: opts.harnessDir,
                label: `module server '${parsed.serverId}'`,
              },
              timeoutMs,
            );
          } catch (e) {
            if (e instanceof ChildEnvError) throw new AdapterError("adapter_unresolved", `adapter failure: ${e.message}`);
            throw new AdapterError("host_session_failed", `adapter failure: module stdio spawn failed: ${e instanceof Error ? e.message : e}`);
          }
          sessions.set(parsed.serverId, session);
        }
        try {
          return { output: await session.callTool(toolId, callArgs) };
        } catch (e) {
          throw new AdapterError(
            "host_session_failed",
            `adapter failure: module call failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      };
      continue;
    }

    throw new AdapterError(
      "adapter_unresolved",
      `adapter failure: unsupported module transport '${String((cfg as { transport?: string }).transport)}'`,
    );
  }

  return {
    handlers,
    nativeToTool,
    cleanup: () => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}
