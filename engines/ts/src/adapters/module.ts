/**
 * Module host adapters (M17): recorded (Track A) and stdio (live) transports.
 * Resolve stays offline; these run only at bind/execute time.
 * Protocol (stdio): one JSON line request `{tool, args}` → one JSON line `{output}` or `{error}`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { canonicalJson } from "../canonical.js";
import type { ToolHandler } from "../runtime.js";
import type { Deployment, DeploymentModuleServer } from "../types.js";
import { AdapterError } from "./error.js";

const SECRET_KEY_RE = /(api[_-]?key|secret|password|token|credential|authorization)/i;

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
      `adapter failure: module recorded file not found: ${relPath}`,
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
        `adapter failure: invalid module recorded line in ${relPath}`,
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
    if (canonicalJson(e.args ?? {}) !== argsCanon) continue;
    used.add(i);
    return e.result;
  }
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const e = entries[i]!;
    if (e.tool !== tool) continue;
    used.add(i);
    return e.result;
  }
  throw new AdapterError(
    "adapter_unresolved",
    `adapter failure: no recorded module response for tool '${tool}'`,
  );
}

function assertNoSecretEnv(env: Record<string, string> | undefined): void {
  if (!env) return;
  for (const k of Object.keys(env)) {
    if (SECRET_KEY_RE.test(k)) {
      throw new AdapterError(
        "adapter_unresolved",
        `adapter failure: forbidden secret-like module env key '${k}'`,
      );
    }
  }
}

class StdioModuleSession {
  private proc;
  private rl;
  private closed = false;

  constructor(
    command: string,
    args: string[],
    env: Record<string, string> | undefined,
    private timeoutMs: number,
    cwd?: string,
  ) {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      cwd,
      windowsHide: true,
    });
    this.rl = createInterface({ input: this.proc.stdout! });
    this.proc.on("exit", () => {
      this.closed = true;
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("module stdio session closed");
    const payload = JSON.stringify({ tool: name, args }) + "\n";
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`module stdio timeout after ${this.timeoutMs}ms (${name})`));
      }, this.timeoutMs);
      const onLine = (line: string) => {
        clearTimeout(timer);
        this.rl.off("line", onLine);
        try {
          const msg = JSON.parse(line) as { output?: Record<string, unknown>; error?: string };
          if (msg.error) {
            reject(new Error(msg.error));
            return;
          }
          if (!msg.output || typeof msg.output !== "object") {
            reject(new Error(`module stdio '${name}' returned no output object`));
            return;
          }
          resolvePromise(msg.output);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      this.rl.on("line", onLine);
      this.proc.stdin!.write(payload);
    });
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
 * Build handlers for module.* natives. Sessions are created lazily per server.
 */
export function createModuleHandlers(
  deployment: Deployment,
  opts: { harnessDir: string },
): {
  handlers: Record<string, ToolHandler>;
  nativeToTool: Record<string, string>;
  cleanup: () => void;
} {
  const handlers: Record<string, ToolHandler> = {};
  const nativeToTool: Record<string, string> = {};
  const sessions = new Map<string, StdioModuleSession>();
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
    const cfg: DeploymentModuleServer | undefined = moduleCfg[parsed.serverId];
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
          recordedCache.set(parsed.serverId, loadRecordedMap(opts.harnessDir, recPath));
          recordedUsed.set(parsed.serverId, new Set());
        }
        const entries = recordedCache.get(parsed.serverId)!;
        const used = recordedUsed.get(parsed.serverId)!;
        const result = matchRecorded(entries, toolId, args, used);
        if ("output" in result && typeof result.output === "object") {
          return result as { output: Record<string, unknown> };
        }
        return { output: result };
      };
      continue;
    }

    if (cfg.transport === "stdio") {
      if (!cfg.command) {
        throw new AdapterError(
          "adapter_unresolved",
          `adapter failure: module.${parsed.serverId} stdio transport requires command`,
        );
      }
      assertNoSecretEnv(cfg.env);
      const command = cfg.command;
      const args = cfg.args ?? [];
      const timeoutMs = cfg.timeout_ms ?? 15_000;
      handlers[toolId] = async (callArgs) => {
        let session = sessions.get(parsed.serverId);
        if (!session) {
          session = new StdioModuleSession(
            command,
            args,
            cfg.env,
            timeoutMs,
            opts.harnessDir,
          );
          sessions.set(parsed.serverId, session);
        }
        const output = await session.callTool(toolId, callArgs);
        return { output };
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
