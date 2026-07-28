export type Verdict = "allow" | "deny" | "safe_state";

export type ReasonCode =
  | "gate_denied"
  | "capability_missing"
  | "limit_exceeded"
  | "verify_effect_failed"
  | "verify_evidence_failed"
  | "verify_absence_failed"
  | "verify_judge_invalid"
  | "verify_judge_failed"
  | "schema_invalid"
  | "input_schema_invalid"
  | "output_schema_invalid"
  | "tool_execution_failed"
  | "safe_state_entered"
  | "recovery_succeeded"
  | "terminal_failure"
  | "mode_denied"
  | "sequence_requirement_failed"
  | "memory_stale"
  | "completion_gate_failed"
  | "checkpoint_authority_failed"
  | "user_checkpoint_required";

export type CounterbalanceMode = {
  id: string;
  tools?: string[];
};

export type CounterbalanceSequence = {
  id?: string;
  action: string;
  require_prior_tools?: string[];
  require_state?: Predicate;
};

export type CounterbalanceInvalidateAfter = {
  action: string;
  memory_keys: string[];
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

/** Executable Counterbalance extensions (v0.1 bridge). */
export type CounterbalanceExt = {
  modes?: CounterbalanceMode[];
  sequences?: CounterbalanceSequence[];
  invalidate_after?: CounterbalanceInvalidateAfter[];
  completion?: CounterbalanceCompletion;
  checkpoints?: CounterbalanceCheckpointPolicy[];
  orientation?: CounterbalanceOrientation;
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

export type VerifyJudge = {
  kind: "judge";
  model_from?: string;
  rubric: string;
  require: Predicate;
  otherwise?: Verdict;
};

export type Verify = VerifyEffect | VerifyEvidence | VerifyAbsence | VerifyJudge;

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
  /** Counterbalance bridge — modes, sequences, invalidate_after (see spec-v0.2-draft). */
  counterbalance?: CounterbalanceExt;
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
  /** Nesting depth (0 = root). Set on child reaction events. */
  depth?: number;
  /** Id of the parent spawn that produced this event (child log only). */
  spawn_id?: string;
};

export type ModelProposal =
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "stop"; message?: string };

export type Snapshot = {
  action?: { name: string; args: Record<string, unknown> };
  state: Record<string, unknown>;
  result?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  judgment?: Record<string, unknown>;
};

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
  path?: string;
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

export type ResolvedConnectorEntry = {
  id: string;
  kind: "inline" | "file" | "mcp";
  path?: string;
  sha256: string | null;
  provides: string[];
  selected: string[];
  /** For mcp connectors: harness tool id → remote MCP tool name. */
  mcp_tools?: Record<string, string>;
};

export type ResolvedConnectorLockEntry = {
  connector: string;
  kind: "inline" | "file" | "mcp";
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
