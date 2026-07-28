/**
 * MCP host adapters: recorded (Track A) and stdio (live) transports.
 * Resolve stays offline; these run only at bind/execute time.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { canonicalJson } from "../canonical.js";
import type { ToolHandler } from "../runtime.js";
import type { Deployment, DeploymentMcpServer, ResolvedHarnessIR } from "../types.js";
import { AdapterError } from "./error.js";

const SECRET_KEY_RE = /(api[_-]?key|secret|password|token|credential|authorization)/i;

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

type RecordedEntry = {
  tool: string;
  args?: Record<string, unknown>;
  result: Record<string, unknown>;
};

function loadRecordedMap(harnessDir: string, relPath: string): RecordedEntry[] {
  const abs = resolve(harnessDir, relPath);
  if (!existsSync(abs)) {
    throw new AdapterError(
      "adapter_unresolved",
      `adapter failure: mcp recorded file not found: ${relPath}`,
    );
  }
  const lines = readFileSync(abs, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const entries: RecordedEntry[] = [];
  for (const line of lines) {
    const row = JSON.parse(line) as RecordedEntry;
    if (!row || typeof row.tool !== "string" || !row.result || typeof row.result !== "object") {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: invalid mcp recorded line in ${relPath}`,
      );
    }
    entries.push(row);
  }
  return entries;
}

function matchRecorded(
  entries: RecordedEntry[],
  tool: string,
  args: Record<string, unknown>,
  used: Set<number>,
): Record<string, unknown> {
  const argsCanon = canonicalJson(args ?? {});
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const e = entries[i]!;
    if (e.tool !== tool) continue;
    const eArgs = canonicalJson(e.args ?? {});
    if (eArgs !== argsCanon) continue;
    used.add(i);
    return e.result;
  }
  // Fallback: match by tool only (first unused)
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const e = entries[i]!;
    if (e.tool !== tool) continue;
    used.add(i);
    return e.result;
  }
  throw new AdapterError(
    "adapter_unresolved",
    `adapter failure: no recorded mcp response for tool '${tool}'`,
  );
}

function assertNoSecretEnv(env: Record<string, string> | undefined): void {
  if (!env) return;
  for (const k of Object.keys(env)) {
    if (SECRET_KEY_RE.test(k)) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: forbidden secret-like mcp env key '${k}'`,
      );
    }
  }
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
};

class StdioMcpSession {
  private proc;
  private rl;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private bufferReady: Promise<void>;
  private closed = false;

  constructor(
    command: string,
    args: string[],
    env: Record<string, string> | undefined,
    private timeoutMs: number,
  ) {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    this.rl = createInterface({ input: this.proc.stdout! });
    this.bufferReady = new Promise((resolveReady) => {
      this.rl.on("line", (line) => {
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          return;
        }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message));
          } else {
            p.resolve(msg.result);
          }
        }
      });
      this.proc.on("error", (err) => {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      });
      this.proc.on("exit", () => {
        this.closed = true;
        for (const p of this.pending.values()) {
          p.reject(new Error("mcp stdio process exited"));
        }
        this.pending.clear();
      });
      resolveReady();
    });
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    await this.bufferReady;
    if (this.closed) {
      throw new Error("mcp stdio session closed");
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp stdio timeout after ${this.timeoutMs}ms (${method})`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin!.write(JSON.stringify(payload) + "\n");
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fausth", version: "0.1.2-alpha" },
    });
    // notifications/initialized (no id)
    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
    if (result?.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent as Record<string, unknown>;
    }
    const text = result?.content?.find((c) => c.type === "text")?.text;
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return { text };
      }
    }
    throw new Error(`mcp tools/call '${name}' returned no structured result`);
  }

  close(): void {
    try {
      this.rl.close();
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }
}

/**
 * Build handlers for mcp.* natives. Sessions are created lazily per server.
 */
export function createMcpHandlers(
  deployment: Deployment,
  opts: {
    harnessDir: string;
    mcpToolMap?: Record<string, string>;
  },
): {
  handlers: Record<string, ToolHandler>;
  nativeToTool: Record<string, string>;
  cleanup: () => void;
} {
  const handlers: Record<string, ToolHandler> = {};
  const nativeToTool: Record<string, string> = {};
  const sessions = new Map<string, StdioMcpSession>();
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
    const server = mcpCfg[parsed.serverId];
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
          recordedCache.set(
            parsed.serverId,
            loadRecordedMap(opts.harnessDir, recordedPath),
          );
          recordedUsed.set(parsed.serverId, new Set());
        }
        const entries = recordedCache.get(parsed.serverId)!;
        const used = recordedUsed.get(parsed.serverId)!;
        const result = matchRecorded(entries, remoteName, args as Record<string, unknown>, used);
        return { output: result };
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
      assertNoSecretEnv(server.env);
      const timeout = server.timeout_ms ?? 15_000;
      const command = server.command;
      const args = server.args ?? [];
      handlers[toolId] = async (callArgs) => {
        let session = sessions.get(parsed.serverId);
        if (!session) {
          session = new StdioMcpSession(command, args, server.env, timeout);
          sessions.set(parsed.serverId, session);
          try {
            await session.initialize();
          } catch (e) {
            session.close();
            sessions.delete(parsed.serverId);
            throw new AdapterError(
              "adapter_unresolved",
              `adapter failure: mcp stdio initialize failed: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
        try {
          const result = await session.callTool(
            remoteName,
            callArgs as Record<string, unknown>,
          );
          return { output: result };
        } catch (e) {
          throw new AdapterError(
            "adapter_unresolved",
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
