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
  | "terminal_failure";

export type Stage =
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

export const INT53_MAX = 9007199254740991;
export const INT53_MIN = -9007199254740991;
