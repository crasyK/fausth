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
  | "safe_state_entered";

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
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  verify?: Verify[];
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
  safe_state?: Record<string, unknown>;
  permissions?: {
    tools?: string[];
    filesystem?: { write_scopes?: string[]; read_scopes?: string[] };
  };
  spawn?: {
    allow?: boolean;
    tighten_only?: boolean;
  };
};

export type Deployment = {
  platform?: string;
  model: {
    transport: "recorded" | "ollama" | "openai-compatible" | "openrouter";
    models?: string[];
    model?: string;
    endpoint?: string;
    temperature?: number;
    max_tokens?: number;
    judge_model?: string;
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
