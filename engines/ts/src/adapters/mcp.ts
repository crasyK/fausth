/**
 * MCP host adapters: recorded (Track A) and stdio (live) transports.
 * Resolve stays offline; these run only at bind/execute time.
 * Session plumbing (env allowlist, stderr drain, timeouts, cleanup, spawn policy) lives in
 * stdio-session.ts and is shared with module connectors.
 */
import { join } from "node:path";
import type { ToolHandler } from "../runtime.js";
import type { Deployment, DeploymentMcpServer, ResolvedHarnessIR } from "../types.js";
import { AdapterError } from "./error.js";
import { assertNoSecretEnvNames, ChildEnvError } from "./child-process.js";
import {
  assertSpawnAllowed,
  loadRecordedEntries,
  matchRecordedExact,
  McpStdioSession,
  type RecordedEntry,
  type SpawnPolicy,
} from "./stdio-session.js";

export function parseMcpNative(
  native: string,
): { serverId: string; toolId: string } | null {
  if (!native.startsWith("mcp.")) return null;
  const rest = native.slice("mcp.".length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { serverId: rest.slice(0, dot), toolId: rest.slice(dot + 1) };
}

export function deploymentUsesMcp(deployment: Deployment): boolean {
  return Object.values(deployment.bindings ?? {}).some(
    (b) => typeof b.native === "string" && b.native.startsWith("mcp."),
  );
}

export function mcpToolMapFromResolved(resolved?: ResolvedHarnessIR): Record<string, string> {
  const out: Record<string, string> = {};
  if (!resolved) return out;
  for (const c of resolved.resolution.connectors) {
    if (c.kind !== "mcp" || !c.mcp_tools) continue;
    for (const [id, name] of Object.entries(c.mcp_tools)) {
      out[id] = name;
    }
  }
  return out;
}

/** Server config extension: explicit host env names to pass through (non-secret only). */
type McpServerConfig = DeploymentMcpServer & { env_passthrough?: string[] };

function validateServerEnv(serverId: string, server: McpServerConfig): void {
  if (server.env !== undefined) {
    if (!server.env || typeof server.env !== "object" || Array.isArray(server.env)) {
      throw new AdapterError("adapter_unresolved", `adapter failure: mcp server '${serverId}' env must be an object`);
    }
  }
  if (server.env_passthrough !== undefined && !Array.isArray(server.env_passthrough)) {
    throw new AdapterError(
      "adapter_unresolved",
      `adapter failure: mcp server '${serverId}' env_passthrough must be a list of names`,
    );
  }
  try {
    assertNoSecretEnvNames([...Object.keys(server.env ?? {}), ...(server.env_passthrough ?? [])], "mcp");
  } catch (e) {
    if (e instanceof ChildEnvError) throw new AdapterError("adapter_unresolved", `adapter failure: ${e.message}`);
    throw e;
  }
}

/**
 * Build handlers for mcp.* natives. Sessions are created lazily per server; `cleanup`
 * terminates them (callers must invoke it; process exit also reaps them).
 */
export function createMcpHandlers(
  deployment: Deployment,
  opts: {
    harnessDir: string;
    mcpToolMap?: Record<string, string>;
    spawnPolicy?: SpawnPolicy;
  },
): {
  handlers: Record<string, ToolHandler>;
  nativeToTool: Record<string, string>;
  cleanup: () => void;
} {
  const handlers: Record<string, ToolHandler> = {};
  const nativeToTool: Record<string, string> = {};
  const sessions = new Map<string, McpStdioSession>();
  const recordedUsed = new Map<string, Set<number>>();
  const recordedCache = new Map<string, RecordedEntry[]>();
  const mcpCfg = deployment.mcp ?? {};
  const toolMap = opts.mcpToolMap ?? {};

  for (const [toolId, binding] of Object.entries(deployment.bindings ?? {})) {
    const native = binding.native;
    if (typeof native !== "string" || !native.startsWith("mcp.")) continue;
    const parsed = parseMcpNative(native);
    if (!parsed) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: invalid mcp native '${native}' (expected mcp.<server>.<tool>)`,
      );
    }
    if (parsed.toolId !== toolId) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: native '${native}' maps to '${parsed.toolId}', not '${toolId}'`,
      );
    }
    const server = Object.prototype.hasOwnProperty.call(mcpCfg, parsed.serverId)
      ? (mcpCfg[parsed.serverId] as McpServerConfig)
      : undefined;
    if (!server) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: no deployment.mcp['${parsed.serverId}'] for native '${native}'`,
      );
    }
    nativeToTool[native] = toolId;
    const remoteName = toolMap[toolId] ?? toolId;

    if (server.transport === "recorded") {
      if (!server.recorded) {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: mcp server '${parsed.serverId}' recorded transport requires recorded path`,
        );
      }
      const recordedPath = server.recorded;
      handlers[toolId] = (args) => {
        if (!recordedCache.has(parsed.serverId)) {
          recordedCache.set(parsed.serverId, loadRecordedEntries(opts.harnessDir, recordedPath, "mcp"));
          recordedUsed.set(parsed.serverId, new Set());
        }
        const entries = recordedCache.get(parsed.serverId)!;
        const used = recordedUsed.get(parsed.serverId)!;
        return { output: matchRecordedExact(entries, remoteName, args, used, "mcp") };
      };
      continue;
    }

    if (server.transport === "stdio") {
      if (!server.command || typeof server.command !== "string") {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: mcp server '${parsed.serverId}' stdio transport requires command`,
        );
      }
      validateServerEnv(parsed.serverId, server);
      const timeout = server.timeout_ms ?? 15_000;
      const command = server.command;
      const args = server.args ?? [];
      handlers[toolId] = async (callArgs) => {
        let session = sessions.get(parsed.serverId);
        if (session?.closed) {
          sessions.delete(parsed.serverId);
          session = undefined;
        }
        if (!session) {
          assertSpawnAllowed(command, opts.spawnPolicy, "mcp stdio");
          try {
            session = new McpStdioSession(
              {
                command,
                args,
                env: server.env,
                envPassthrough: server.env_passthrough,
                cwd: opts.harnessDir,
                label: `mcp server '${parsed.serverId}'`,
              },
              timeout,
            );
          } catch (e) {
            if (e instanceof ChildEnvError) throw new AdapterError("adapter_unresolved", `adapter failure: ${e.message}`);
            throw new AdapterError("host_session_failed", `adapter failure: mcp stdio spawn failed: ${e instanceof Error ? e.message : e}`);
          }
          sessions.set(parsed.serverId, session);
          try {
            await session.initialize();
          } catch (e) {
            session.close();
            sessions.delete(parsed.serverId);
            throw new AdapterError(
              "host_session_failed",
              `adapter failure: mcp stdio initialize failed: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
        try {
          return { output: await session.callTool(remoteName, callArgs as Record<string, unknown>) };
        } catch (e) {
          throw new AdapterError(
            "host_session_failed",
            `adapter failure: mcp tools/call failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      };
      continue;
    }

    throw new AdapterError(
      "adapter_unresolved",
      `adapter failure: unsupported mcp transport '${String((server as DeploymentMcpServer).transport)}'`,
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

/** Convenience for tests that only need harness-relative recorded path join. */
export function mcpRecordedPath(harnessDir: string, rel: string): string {
  return join(harnessDir, rel);
}
