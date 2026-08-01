export type Verdict = "allow" | "deny" | "safe_state";

export type ReasonCode =
  | "gate_denied"
  | "capability_missing"
  | "limit_exceeded"
  | "verify_effect_failed"
  | "verify_evidence_failed"
  | "verify_absence_failed"
  | "verify_output_failed"
  | "verify_judge_invalid"
  | "verify_judge_failed"
  | "budget_exceeded"
  | "schema_invalid"
  | "input_schema_invalid"
  | "output_schema_invalid"
  | "tool_execution_failed"
  | "safe_state_entered"
  | "recovery_succeeded"
  | "terminal_failure"
  | "sequence_requirement_failed"
  | "memory_stale"
  | "completion_gate_failed"
  | "checkpoint_authority_failed"
  | "user_checkpoint_required"
  | "empty_proposal"
  | "harness_patch_denied"
  | "harness_patch_applied"
  | "harness_patch_invalid"
  | "harness_patch_declined";

/** Cells the agent may propose harness edits to (never security / checkpoints). */
export type MutableCell = "skills" | "memory" | "instincts";

/** Structured harness self-edit ops (v0.1 IR maps skills → tool descriptions). */
export type HarnessPatchOp =
  | { op: "set_tool_description"; tool_id: string; description: string }
  | { op: "set_memory_note"; key: string; note: string }
  | { op: "set_instinct_text"; text: string }
  | { op: "set_permissions_tools"; tools: string[] }
  | { op: "set_sequences"; sequences: unknown[] }
  | { op: "set_checkpoints"; checkpoints: unknown[] }
  | { op: "set_tool_id"; tool_id: string; new_id: string }
  | { op: "set_tool_verify"; tool_id: string; verify: unknown[] }
  | { op: "set_tool_input"; tool_id: string; input: Record<string, unknown> }
  | { op: "set_tool_output"; tool_id: string; output: Record<string, unknown> };

export type HarnessPatch = {
  ops: HarnessPatchOp[];
};

export type CounterbalanceSequence = {
  id?: string;
  action: string;
  /** All listed tools must have succeeded earlier (AND). */
  require_prior_tools?: string[];
  /** At least one listed tool must have succeeded earlier (OR). */
  require_prior_any_of?: string[];
  require_state?: Predicate;
};

/** Closed reason codes for `harness.decline_skills_patch`. */
export type SkillsPatchDeclineReason =
  | "no_new_heuristic"
  | "insufficient_evidence"
  | "would_overfit_task"
  | "skills_already_adequate";

export type SkillsPatchDecline = {
  reason: SkillsPatchDeclineReason;
  note?: string;
};

export type CounterbalanceInvalidateAfter = {
  /** Mutation-triggered invalidation (v0.2). XOR with ttl_steps in v0.3. */
  action?: string;
  /** Step-age invalidation (v0.3): stale after N steps since last fresh write. */
  ttl_steps?: number;
  memory_keys: string[];
};

export type MemoryProvenanceEntry = {
  status?: "current" | "stale" | "contradicted" | "unknown";
  source?: "user" | "world" | "agent-inference";
  updated_at_step?: number;
};

export type InterventionBudget = {
  max_activations: number;
  window?: "run" | "host_day";
};

export type CounterbalanceTrigger = {
  id: string;
  kind: "cron" | "event" | "human";
  every_seconds?: number;
};

export type CounterbalanceCompletion = {
  tool?: string;
  require?: Predicate;
};

export type CounterbalanceCheckpointPolicy = {
  /** Tool id that requires adapter-attested state transitions. */
  tool: string;
  /** Only these state keys may be set by the checkpoint tool. */
  allow_set_keys: string[];
};

export type CounterbalanceOrientation = {
  /** Emit deterministic orientation snapshots before each proposal. */
  emit_each_step?: boolean;
};

/** Executable Counterbalance extensions (v0.1 bridge + v0.3 candidates). */
export type CounterbalanceExt = {
  sequences?: CounterbalanceSequence[];
  invalidate_after?: CounterbalanceInvalidateAfter[];
  completion?: CounterbalanceCompletion;
  checkpoints?: CounterbalanceCheckpointPolicy[];
  orientation?: CounterbalanceOrientation;
  /** Assistant/tool message verifies (v0.3). */
  output_verifies?: VerifyOutput[];
  memory_provenance?: Record<string, MemoryProvenanceEntry>;
  intervention_budget?: InterventionBudget;
  triggers?: CounterbalanceTrigger[];
  /** Optional memory notes (mutable when `mutable` includes memory). */
  memory_notes?: Record<string, string>;
};
export type Stage =
  | "orient"
  | "propose"
  | "validate"
  | "authorize"
  | "execute"
  | "verify"
  | "observe"
  | "record"
  | "rebalance";

export type Predicate =
  | { path: string; eq: unknown }
  | { path: string; eq_path: string }
  | { path: string; neq: unknown }
  | { path: string; lt: number }
  | { path: string; lte: number }
  | { path: string; gt: number }
  | { path: string; gte: number }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

/** Structured counterbalance deny signal (machine-checkable; no prose in event log). */
export type DenyFailureUnblock = {
  tool: string;
  set_key: string;
  set_value: unknown;
};

export type DenyFailureItem = {
  path: string;
  current: unknown;
  require: Record<string, unknown>;
  unblock?: DenyFailureUnblock;
};

export type DenyFailure =
  | { kind: "predicate"; failed: DenyFailureItem[] }
  | { kind: "missing_prior_tools"; missing_prior_tools: string[] }
  | { kind: "missing_prior_any_of"; options: string[] }
  | { kind: "checkpoint_key"; checkpoint_key: string };

export type Gate = {
  id?: string;
  when?: Predicate;
  require: Predicate;
  otherwise?: Verdict;
};

export type VerifyEffect = {
  kind: "effect";
  observe: string;
  require: Predicate;
  otherwise?: Verdict;
};

export type VerifyEvidence = {
  kind: "evidence";
  require: Predicate;
  otherwise?: Verdict;
};

export type VerifyAbsence = {
  kind: "absence";
  require: Predicate;
  otherwise?: Verdict;
};

/** Predicates on assistant/tool message content (`message.*` snapshot paths). */
export type VerifyOutput = {
  kind: "output";
  require: Predicate;
  otherwise?: Verdict;
};

export type VerifyJudge = {
  kind: "judge";
  model_from?: string;
  rubric: string;
  require: Predicate;
  otherwise?: Verdict;
};

export type Verify =
  | VerifyEffect
  | VerifyEvidence
  | VerifyAbsence
  | VerifyOutput
  | VerifyJudge;

export type ToolDef = {
  id: string;
  description?: string;
  read_only?: boolean;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  verify?: Verify[];
};

export type StateTransition = {
  set?: Record<string, unknown>;
  remove?: string[];
};

export type ToolResultEnvelope = {
  output: Record<string, unknown>;
  state_transition?: StateTransition;
};

export type Recovery = {
  on?: ReasonCode | string;
  execute: { tool: string; args?: Record<string, unknown> };
  verify: Verify;
  on_failure?: "terminal_failure";
};

export type AgentIR = {
  spec: string;
  name: string;
  state: Record<string, unknown>;
  tools: ToolDef[];
  gates?: Gate[];
  limits?: {
    max_steps?: number;
    max_tool_calls?: number;
    timeout_ms?: number;
    /** When true, plain deny verdicts continue the loop; limit_exceeded and safe_state still stop. */
    continue_after_deny?: boolean;
  };
  /** @deprecated use fallback_state */
  safe_state?: Record<string, unknown>;
  fallback_state?: Record<string, unknown>;
  recovery?: Recovery;
  permissions?: {
    tools?: string[];
    filesystem?: { write_scopes?: string[]; read_scopes?: string[] };
  };
  spawn?: {
    allow?: boolean;
    tighten_only?: boolean;
    allow_nested?: boolean;
  };
  /** Counterbalance bridge — sequences, invalidate_after, completion (see spec-v0.2). */
  counterbalance?: CounterbalanceExt;
  /** Non-normative → normative candidate: cells agent may propose edits to. */
  mutable?: MutableCell[];
  /** Optional instinct disposition text (mutable when `mutable` includes instincts). */
  instinct_text?: string;
  /**
   * Model-adaptive scaffolding overlays (M18).
   * May only narrow tools/limits; never widen. Stripped after resolveOverlay.
   */
  overlays?: import("./overlays.js").HarnessOverlay[];
};

export type DeploymentModel = {
  /** Preferred: openai-compatible. Legacy: openrouter | ollama | recorded. */
  transport?: "recorded" | "ollama" | "openai-compatible" | "openrouter";
  /** Provider profile supplying defaults (kit-scc | openrouter | ollama | generic). */
  profile?: "generic" | "kit-scc" | "openrouter" | "ollama";
  models?: string[];
  model?: string;
  /** @deprecated use base_url */
  endpoint?: string;
  base_url?: string;
  /** Env var name for the API key — never put the secret in YAML. */
  api_key_env?: string;
  /** Forbidden — secrets must not appear in deployment files. */
  api_key?: string;
  temperature?: number;
  max_tokens?: number;
  judge_model?: string;
  compatibility?: {
    preserve_response_fields?: string[];
    gateway_system_prompt?: "prohibited" | "unknown";
  };
};

export type ModelPolicyMeta = {
  residency?: string;
  processing_location?: string;
  personal_data?: "allowed" | "prohibited";
  confidential_data?: "allowed" | "prohibited";
};

export type DeploymentModelEntry = {
  id: string;
  capabilities?: {
    tools?: boolean;
    json?: boolean;
  };
  policy?: ModelPolicyMeta;
};

/** Local disposable-worktree world settings (M8). Narrowing only — never widens agent scopes. */
export type DeploymentWorld = {
  /** Optional declared worktree; must match CLI `--workspace` when set. */
  worktree_root?: string;
  shell_timeout_ms?: number;
  max_read_bytes?: number;
  max_output_bytes?: number;
  /** Logical command → argv (no shell). Keys typically `test` / `typecheck`. */
  commands?: Record<string, string[]>;
  scopes?: {
    read?: string[];
    write?: string[];
  };
};

export type DeploymentMcpServer = {
  transport: "recorded" | "stdio";
  /** Harness-relative path to recorded MCP responses (jsonl). Required for recorded. */
  recorded?: string;
  /** Executable for stdio MCP server. Required for stdio. */
  command?: string;
  args?: string[];
  /** Optional env overlay (no secret-like keys). */
  env?: Record<string, string>;
  timeout_ms?: number;
};

/** Module connector execution (M17) — subprocess only; resolve stays offline. */
export type DeploymentModuleServer = {
  transport: "recorded" | "stdio";
  /** Harness-relative path to recorded module responses (jsonl). */
  recorded?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeout_ms?: number;
};

export type Deployment = {
  platform?: string;
  model: DeploymentModel;
  /** Optional per-model policy metadata (admin-authored; not from remote catalogs). */
  model_catalog?: DeploymentModelEntry[];
  data_policy?: {
    classification?: string;
    require?: { residency?: string };
  };
  bindings: Record<string, { native: string; [k: string]: unknown }>;
  permissions?: Record<string, unknown>;
  /** Real local I/O settings for `local.*` bindings. */
  world?: DeploymentWorld;
  /** Host-side MCP server configs keyed by connector/server id. */
  mcp?: Record<string, DeploymentMcpServer>;
  /** Host-side module server configs keyed by connector/server id. */
  module?: Record<string, DeploymentModuleServer>;
};

export type Event = {
  seq: number;
  ts_logical: number;
  stage: Stage;
  verdict?: Verdict;
  reason?: ReasonCode;
  tool?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  state_hash: string;
  error?: string;
  /** Structured counterbalance deny facts (completion, sequence, checkpoint). */
  failure?: DenyFailure;
  /** Nesting depth (0 = root). Set on child reaction events. */
  depth?: number;
  /** Id of the parent spawn that produced this event (child log only). */
  spawn_id?: string;
  /** Harness IR hash before a successful patch (rebalance stage). */
  harness_hash_before?: string;
  /** Harness IR hash after a successful patch (rebalance stage). */
  harness_hash_after?: string;
};

export type ModelProposal =
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "stop"; message?: string }
  | { type: "invalid"; reason: string; message?: string };

export type MessageSnapshot = {
  content: string;
  contains_code_fence: number;
  length: number;
};

export type Snapshot = {
  action?: { name: string; args: Record<string, unknown> };
  state: Record<string, unknown>;
  result?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  judgment?: Record<string, unknown>;
  message?: MessageSnapshot;
};

/** Build message.* paths for kind:output verifies. */
export function buildMessageSnapshot(content: string): MessageSnapshot {
  const c = String(content ?? "");
  return {
    content: c,
    contains_code_fence: c.includes("```") ? 1 : 0,
    length: c.length,
  };
}

export type RecordedToolCall = {
  call_seq: number;
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | ToolResultEnvelope;
};

/** Connector provision that can be linked into AgentIR.tools. */
export type ConnectorProvision = {
  id: string;
  description?: string;
  read_only?: boolean;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  verify?: Verify[];
  /** Remote MCP tool name (mcp connectors); defaults to id. */
  mcp_tool?: string;
};

export type InlineConnectorSource = {
  id: string;
  kind: "inline";
  provides: ConnectorProvision[];
  select?: string[];
};

export type FileConnectorSource = {
  id: string;
  kind: "file";
  path: string;
  sha256?: string;
  select?: string[];
};

export type McpConnectorSource = {
  id: string;
  kind: "mcp";
  descriptor: string;
  sha256?: string;
  select?: string[];
};

export type ModuleConnectorSource = {
  id: string;
  kind: "module";
  path: string;
  sha256?: string;
  select?: string[];
};

export type ConnectorSource =
  | InlineConnectorSource
  | FileConnectorSource
  | McpConnectorSource
  | ModuleConnectorSource;

export type ConnectorsFile = {
  format: "fausth-connectors/v0.1";
  connectors: ConnectorSource[];
};

export type ConnectorFileManifest = {
  format: "fausth-connector-manifest/v0.1";
  provides: ConnectorProvision[];
};

export type McpDescriptor = {
  format: "fausth-mcp-descriptor/v0.1";
  provides: ConnectorProvision[];
};

export type ModuleManifest = {
  format: "fausth-module-manifest/v0.1";
  provides: ConnectorProvision[];
  /** Documented subprocess argv; deployment owns live execution. */
  command?: string[];
};

export type ResolvedConnectorEntry = {
  id: string;
  kind: "inline" | "file" | "mcp" | "module";
  path?: string;
  sha256: string | null;
  provides: string[];
  selected: string[];
  /** For mcp connectors: harness tool id → remote MCP tool name. */
  mcp_tools?: Record<string, string>;
};

export type ResolvedConnectorLockEntry = {
  connector: string;
  kind: "inline" | "file" | "mcp" | "module";
  path?: string;
  sha256: string;
};

export type HarnessResolution = {
  connectors: ResolvedConnectorEntry[];
  selected: string[];
  lock: ResolvedConnectorLockEntry[];
};

/** Compile/link output: executable AgentIR plus connector lock metadata. */
export type ResolvedHarnessIR = {
  format: "fausth-resolved-harness/v0.1";
  agent: AgentIR;
  resolution: HarnessResolution;
};

export const INT53_MAX = 9007199254740991;
export const INT53_MIN = -9007199254740991;
