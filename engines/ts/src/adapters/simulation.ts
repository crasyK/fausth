/**
 * Simulation world adapter — deterministic fake FS/shell for harness tests without live I/O.
 * Used by Track A coding fixtures and `fausth` local simulation runs.
 */
import type { ToolHandler } from "../runtime.js";
import type { ToolResultEnvelope } from "../types.js";
import { createCodingTools, type CodingWorld } from "../tools/world.js";

export type SimulationWorldOptions = {
  files?: Record<string, string>;
  write_scopes?: string[];
  /** Scripted exit codes per cmd; default test/typecheck → 0 */
  exit_codes?: Record<string, number>;
};

/**
 * Bind coding tools to an in-memory world (no real filesystem or process).
 */
export function createSimulationCodingAdapter(
  opts: SimulationWorldOptions = {},
): { world: CodingWorld; tools: Record<string, ToolHandler> } {
  const world: CodingWorld = {
    files: { "src/app.ts": "export {}", ...(opts.files ?? {}) },
    write_scopes: opts.write_scopes ?? ["src/"],
    last_exit_code: 0,
    out_of_scope_writes: 0,
  };
  const base = createCodingTools(world);
  const exitCodes = opts.exit_codes ?? {};
  const shell: ToolHandler = (args): ToolResultEnvelope => {
    const cmd = String(args.cmd);
    const code = exitCodes[cmd] ?? (cmd === "test" || cmd === "typecheck" ? world.last_exit_code : 1);
    if (cmd === "test" || cmd === "typecheck" || exitCodes[cmd] !== undefined) {
      return { output: { exit_code: code, cmd } };
    }
    return { output: { exit_code: 1, cmd, error: "not allowlisted" } };
  };
  return {
    world,
    tools: {
      ...base,
      "shell.run_allowlisted": shell,
    },
  };
}
