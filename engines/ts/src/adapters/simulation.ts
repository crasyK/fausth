/**
 * Simulation world adapter — deterministic fake FS/shell for harness tests without live I/O.
 * Used by Track A coding fixtures, `stub.*`/`sim.*` deployments and `fausth` simulation runs.
 *
 * Same policy as the local adapter (EDGE-20): scopes normalized (D7), absent read scopes =
 * unrestricted, absent write scopes = none, secrets + protected paths initialised, the shell
 * restores protected files and sets test evidence on exit 0 — only the I/O is simulated.
 */
import type { ToolHandler } from "../runtime.js";
import type { AgentIR } from "../types.js";
import {
  codingWorldFromAgent,
  createCodingTools,
  type CodingWorld,
} from "../tools/world.js";
import { normalizeScopes } from "./sandbox-path.js";

export type SimulationWorldOptions = {
  files?: Record<string, string>;
  write_scopes?: string[];
  read_scopes?: string[];
  /** Scripted exit codes per cmd; default test/typecheck → 0 */
  exit_codes?: Record<string, number>;
};

/** Files every simulated coding world starts with (merged under explicit files). */
export const SIM_DEFAULT_FILES: Readonly<Record<string, string>> = { "src/app.ts": "export {}" };

/**
 * Bind coding tools to an in-memory world (no real filesystem or process).
 */
export function createSimulationCodingAdapter(
  opts: SimulationWorldOptions = {},
): { world: CodingWorld; tools: Record<string, ToolHandler> } {
  const world: CodingWorld = {
    files: { ...SIM_DEFAULT_FILES, ...(opts.files ?? {}) },
    write_scopes: normalizeScopes(opts.write_scopes ?? ["src/"]),
    read_scopes: opts.read_scopes ? normalizeScopes(opts.read_scopes) : undefined,
    last_exit_code: 0,
    ...(opts.exit_codes ? { exit_codes: { ...opts.exit_codes } } : {}),
    out_of_scope_writes: 0,
  };
  return { world, tools: createCodingTools(world) };
}

/** Simulated coding world built from the agent's own permissions (registry sim bindings). */
export function createSimulationWorldForAgent(
  agent: Pick<AgentIR, "permissions">,
  opts: { files?: Record<string, string>; testExit?: number } = {},
): { world: CodingWorld; tools: Record<string, ToolHandler> } {
  const world = codingWorldFromAgent(agent, {
    files: { ...SIM_DEFAULT_FILES, ...(opts.files ?? {}) },
    testExit: opts.testExit ?? 0,
  });
  return { world, tools: createCodingTools(world) };
}
