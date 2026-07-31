import { canonicalJson, deepEq, stateHash } from "./canonical.js";
import {
  buildCheckpointKeyFailure,
  buildMissingPriorToolsFailure,
  buildPredicateFailure,
} from "./deny-failure.js";
import { evalPredicate } from "./predicates.js";
import { validateAgainstSchema } from "./schema-validate.js";
import { fallbackStateOf } from "./load.js";
import type {
  AgentIR,
  Event,
  DenyFailure,
  Gate,
  ModelProposal,
  ReasonCode,
  RecordedToolCall,
  Snapshot,
  StateTransition,
  ToolDef,
  ToolResultEnvelope,
  Verdict,
  Verify,
  VerifyOutput,
} from "./types.js";
import { buildMessageSnapshot } from "./types.js";

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { state: Record<string, unknown> },
) => Promise<ToolResultEnvelope | Record<string, unknown>> | ToolResultEnvelope | Record<string, unknown>;

export type JudgeFn = (
  rubric: string,
  context: Record<string, unknown>,
) => Promise<{ score: number; reason: string } | { invalid: true; raw: string }>;

export type RuntimeOptions = {
  agent: AgentIR;
  propose: () => Promise<ModelProposal | null>;
  tools: Record<string, ToolHandler>;
  judge?: JudgeFn;
  allowJudge?: boolean;
  recordedToolResults?: RecordedToolCall[];
  /** Nesting depth for spawn children (default 0). */
  depth?: number;
  /** Parent spawn id when this runtime is a child reaction. */
  spawnId?: string;
};

function normalizeEnvelope(
  raw: ToolResultEnvelope | Record<string, unknown>,
): ToolResultEnvelope {
  if (raw && typeof raw === "object" && "output" in raw && typeof (raw as ToolResultEnvelope).output === "object") {
    return raw as ToolResultEnvelope;
  }
  if (raw && typeof raw === "object" && "_state_patch" in raw) {
    throw new Error("_state_patch is forbidden; use state_transition");
  }
  return { output: raw as Record<string, unknown> };
}

function scopeCovered(child: string, parents: string[]): boolean {
  return parents.some((p) => {
    if (child === p) return true;
    const prefix = p.endsWith("/") ? p : p + "/";
    return child.startsWith(prefix) || child === p.replace(/\/$/, "");
  });
}

export class FaustRuntime {
  agent: AgentIR;
  events: Event[] = [];
  private seq = 0;
  private steps = 0;
  private toolCalls = 0;
  private propose: RuntimeOptions["propose"];
  private tools: Record<string, ToolHandler>;
  private judge?: JudgeFn;
  private allowJudge: boolean;
  private recorded: RecordedToolCall[];
  private recordedIdx = 0;
  private recovering = false;
  private depth: number;
  private spawnId?: string;

  constructor(opts: RuntimeOptions) {
    this.agent = structuredClone(opts.agent);
    if (this.agent.safe_state && !this.agent.fallback_state) {
      this.agent.fallback_state = this.agent.safe_state;
    }
    this.propose = opts.propose;
    this.tools = opts.tools;
    this.judge = opts.judge;
    this.allowJudge = opts.allowJudge ?? false;
    this.recorded = opts.recordedToolResults ?? [];
    this.depth = opts.depth ?? 0;
    this.spawnId = opts.spawnId;
  }

  private emit(partial: Omit<Event, "seq" | "ts_logical" | "state_hash"> & { state_hash?: string }): Event {
    this.seq += 1;
    const ev: Event = {
      seq: this.seq,
      ts_logical: this.seq,
      state_hash: partial.state_hash ?? stateHash(this.agent.state),
      stage: partial.stage,
    };
    if (partial.verdict !== undefined) ev.verdict = partial.verdict;
    if (partial.reason !== undefined) ev.reason = partial.reason;
    if (partial.tool !== undefined) ev.tool = partial.tool;
    if (partial.args !== undefined) ev.args = partial.args;
    if (partial.result !== undefined) ev.result = partial.result;
    if (partial.observation !== undefined) ev.observation = partial.observation;
    if (partial.error !== undefined) ev.error = partial.error;
    if (partial.failure !== undefined) ev.failure = partial.failure;
    if (this.depth > 0) ev.depth = this.depth;
    if (this.spawnId) ev.spawn_id = this.spawnId;
    if (partial.depth !== undefined) ev.depth = partial.depth;
    if (partial.spawn_id !== undefined) ev.spawn_id = partial.spawn_id;
    this.events.push(ev);
    return ev;
  }

  private toolById(id: string): ToolDef | undefined {
    return this.agent.tools.find((t) => t.id === id);
  }

  private parentTools(): string[] {
    return this.agent.permissions?.tools ?? this.agent.tools.map((t) => t.id);
  }

  private checkLimits(): boolean {
    const maxSteps = this.agent.limits?.max_steps ?? 1000;
    const maxTools = this.agent.limits?.max_tool_calls ?? 1000;
    if (this.steps >= maxSteps || this.toolCalls >= maxTools) {
      this.emit({
        stage: "authorize",
        verdict: "deny",
        reason: "limit_exceeded",
      });
      return false;
    }
    return true;
  }

  /** Plain deny stops by default; opt-in continue_after_deny lets the agent recover. */
  private denyIsTerminal(): boolean {
    return this.agent.limits?.continue_after_deny !== true;
  }

  private evalGates(snapshot: Snapshot, gates: Gate[] | undefined): { ok: true } | { ok: false; verdict: Verdict; reason: ReasonCode } {
    if (!gates) return { ok: true };
    for (const g of gates) {
      if (g.when && !evalPredicate(g.when, snapshot)) continue;
      if (!evalPredicate(g.require, snapshot)) {
        return {
          ok: false,
          verdict: g.otherwise ?? "deny",
          reason: "gate_denied",
        };
      }
    }
    return { ok: true };
  }

  private successfulExecutes(): Set<string> {
    const s = new Set<string>();
    for (const e of this.events) {
      if (e.stage === "execute" && e.verdict === "allow" && e.tool) s.add(e.tool);
    }
    return s;
  }

  private collectCompletionPaths(p: unknown, out: string[] = []): string[] {
    if (!p || typeof p !== "object") return out;
    const obj = p as Record<string, unknown>;
    if (typeof obj.path === "string") out.push(obj.path);
    if (Array.isArray(obj.all)) {
      for (const x of obj.all) this.collectCompletionPaths(x, out);
    }
    if (Array.isArray(obj.any)) {
      for (const x of obj.any) this.collectCompletionPaths(x, out);
    }
    if (obj.not) this.collectCompletionPaths(obj.not, out);
    return out;
  }

  private buildOrientationFrame(): Record<string, unknown> {
    const cb = this.agent.counterbalance ?? {};
    // Can-only: advertise tools this harness actually declares — never blocked_tools / modes.
    const permitted = this.agent.tools.map((t) => t.id).sort();
    const done = this.successfulExecutes();
    const sequence_blockers = (cb.sequences ?? [])
      .filter((s) => s.action && (s.require_prior_tools?.length ?? 0) > 0)
      .map((s) => ({
        action: s.action,
        missing_prior_tools: (s.require_prior_tools ?? []).filter((t) => !done.has(t)).sort(),
      }))
      .filter((x) => x.missing_prior_tools.length > 0);
    const freshness: Record<string, number> = {};
    for (const rule of cb.invalidate_after ?? []) {
      for (const key of rule.memory_keys ?? []) {
        freshness[key] = Number(this.agent.state[key] ?? 0);
      }
    }
    const completion = cb.completion;
    const completion_paths = completion?.require
      ? Array.from(new Set(this.collectCompletionPaths(completion.require))).sort()
      : [];
    const completion_ready =
      completion && completion.tool
        ? this.checkCompletion(completion.tool).ok
        : true;
    return {
      permitted_tools: permitted,
      tools: permitted,
      sequence_blockers,
      freshness,
      completion: {
        tool: completion?.tool ?? "task.complete",
        require_paths: completion_paths,
        ready: completion_ready ? 1 : 0,
      },
    };
  }

  private checkSequences(
    action: { name: string; args: Record<string, unknown> },
  ): { ok: true } | { ok: false; reason: ReasonCode; failure: DenyFailure } {
    const seqs = this.agent.counterbalance?.sequences;
    if (!seqs || seqs.length === 0) return { ok: true };
    const done = this.successfulExecutes();
    const snap: Snapshot = { action, state: this.agent.state };
    for (const seq of seqs) {
      if (seq.action !== action.name) continue;
      const missing = (seq.require_prior_tools ?? []).filter((t) => !done.has(t));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: "sequence_requirement_failed",
          failure: buildMissingPriorToolsFailure(missing),
        };
      }
      if (seq.require_state && !evalPredicate(seq.require_state, snap)) {
        return {
          ok: false,
          reason: "sequence_requirement_failed",
          failure: buildPredicateFailure(
            seq.require_state,
            snap,
            this.agent.counterbalance?.checkpoints ?? [],
          ),
        };
      }
    }
    return { ok: true };
  }

  private applyInvalidateAfter(actionName: string): void {
    const rules = this.agent.counterbalance?.invalidate_after;
    if (!rules) return;
    let touched = false;
    const next = { ...this.agent.state };
    for (const rule of rules) {
      if (!rule.action || rule.action !== actionName) continue;
      for (const key of rule.memory_keys) {
        next[key] = 0;
        touched = true;
        this.touchProvenanceStale(key);
      }
    }
    if (!touched) return;
    this.agent.state = next;
    this.emit({
      stage: "record",
      verdict: "allow",
      reason: "memory_stale",
      tool: actionName,
      result: { invalidated: 1 },
    });
  }

  private touchProvenanceStale(key: string): void {
    const mp = this.agent.counterbalance?.memory_provenance;
    if (!mp || !mp[key]) return;
    mp[key] = { ...mp[key], status: "stale", updated_at_step: this.steps };
  }

  private touchProvenanceFresh(key: string): void {
    const cb = this.agent.counterbalance;
    if (!cb) return;
    if (!cb.memory_provenance) cb.memory_provenance = {};
    const prev = cb.memory_provenance[key] ?? {};
    cb.memory_provenance[key] = {
      ...prev,
      status: "current",
      updated_at_step: this.steps,
      source: prev.source ?? "world",
    };
  }

  /** v0.3: ttl_steps invalidation — age evidence without requiring a mutating action. */
  private applyTtlInvalidation(): void {
    const rules = this.agent.counterbalance?.invalidate_after;
    if (!rules) return;
    const mp = this.agent.counterbalance?.memory_provenance ?? {};
    let touched = false;
    const next = { ...this.agent.state };
    for (const rule of rules) {
      if (rule.action || !rule.ttl_steps || rule.ttl_steps < 1) continue;
      for (const key of rule.memory_keys) {
        const meta = mp[key];
        const updated = meta?.updated_at_step ?? 0;
        if (this.steps - updated < rule.ttl_steps) continue;
        if (Number(next[key] ?? 0) === 0 && meta?.status === "stale") continue;
        next[key] = 0;
        this.touchProvenanceStale(key);
        touched = true;
      }
    }
    if (!touched) return;
    this.agent.state = next;
    this.emit({
      stage: "record",
      verdict: "allow",
      reason: "memory_stale",
      result: { invalidated: 1, ttl: 1 },
    });
  }

  /** Host-reported activation count vs intervention_budget (window: run). */
  private checkInterventionBudget(): void {
    const budget = this.agent.counterbalance?.intervention_budget;
    if (!budget || budget.max_activations < 1) return;
    if (budget.window === "host_day") return; // host-persisted; engine does not enforce
    // Each loop iteration that reaches propose counts as one activation for window:run
    // when steps exceeds max — emit telemetry once at the boundary.
    if (this.steps === budget.max_activations + 1) {
      this.emit({
        stage: "record",
        verdict: "allow",
        reason: "budget_exceeded",
        result: {
          max_activations: budget.max_activations,
          activations: this.steps,
          window: budget.window ?? "run",
        },
      });
    }
  }

  private checkCompletion(
    actionName: string,
  ): { ok: true } | { ok: false; reason: ReasonCode; failure: DenyFailure } {
    const completion = this.agent.counterbalance?.completion;
    if (!completion) return { ok: true };
    const tool = completion.tool ?? "task.complete";
    if (actionName !== tool) return { ok: true };
    if (!completion.require) return { ok: true };
    const snap: Snapshot = {
      action: { name: actionName, args: {} },
      state: this.agent.state,
    };
    if (!evalPredicate(completion.require, snap)) {
      return {
        ok: false,
        reason: "completion_gate_failed",
        failure: buildPredicateFailure(
          completion.require,
          snap,
          this.agent.counterbalance?.checkpoints ?? [],
        ),
      };
    }
    return { ok: true };
  }

  private checkCheckpointAuthority(
    action: { name: string; args: Record<string, unknown> },
    transition: StateTransition | undefined,
  ): { ok: true } | { ok: false; reason: ReasonCode; error: string; failure: DenyFailure } {
    const policies = this.agent.counterbalance?.checkpoints ?? [];
    const policy = policies.find((p) => p.tool === action.name);
    if (!policy) return { ok: true };
    const allowed = new Set(policy.allow_set_keys);
    const requested = (action.args.set as Record<string, unknown>) ?? {};
    for (const key of Object.keys(requested)) {
      if (!allowed.has(key)) {
        return {
          ok: false,
          reason: "checkpoint_authority_failed",
          error: `checkpoint args attempted protected key '${key}'`,
          failure: buildCheckpointKeyFailure(key),
        };
      }
    }
    const actualSet = transition?.set ?? {};
    for (const key of Object.keys(actualSet)) {
      if (!allowed.has(key)) {
        return {
          ok: false,
          reason: "checkpoint_authority_failed",
          error: `checkpoint transition attempted protected key '${key}'`,
          failure: buildCheckpointKeyFailure(key),
        };
      }
    }
    return { ok: true };
  }

  private applyStateTransition(transition: StateTransition | undefined): void {
    if (!transition) return;
    const next = { ...this.agent.state };
    if (transition.set) {
      for (const [k, v] of Object.entries(transition.set)) {
        if (!(k in this.agent.state) && Object.keys(this.agent.state).length > 0) {
          // allow setting keys already in state; also allow new keys that match writable convention
        }
        next[k] = v;
        // Fresh write: reset TTL clock when value is truthy / non-zero
        if (v !== 0 && v !== null && v !== undefined && v !== "") {
          this.touchProvenanceFresh(k);
        }
      }
    }
    if (transition.remove) {
      for (const k of transition.remove) {
        delete next[k];
      }
    }
    this.agent.state = next;
  }

  private async invokeNative(name: string, args: Record<string, unknown>): Promise<ToolResultEnvelope> {
    if (this.recorded.length > this.recordedIdx) {
      const entry = this.recorded[this.recordedIdx]!;
      const expectedSeq = this.recordedIdx + 1;
      if (
        entry.call_seq !== expectedSeq ||
        entry.tool !== name ||
        !deepEq(entry.args ?? {}, args)
      ) {
        throw new Error(
          `Recorded transcript mismatch: expected call_seq=${expectedSeq} tool=${name} args=${canonicalJson(args)}, got call_seq=${entry.call_seq} tool=${entry.tool}`,
        );
      }
      this.recordedIdx += 1;
      return normalizeEnvelope(entry.result as ToolResultEnvelope | Record<string, unknown>);
    }
    const handler = this.tools[name];
    if (!handler) {
      throw new Error(`No native handler for ${name}`);
    }
    return normalizeEnvelope(await handler(args, { state: this.agent.state }));
  }

  private applyFallbackState(): void {
    const fb = fallbackStateOf(this.agent);
    if (fb) {
      this.agent.state = { ...this.agent.state, ...fb };
    }
    this.emit({
      stage: "record",
      verdict: "safe_state",
      reason: "safe_state_entered",
    });
  }

  private compareChildEnvelope(args: Record<string, unknown>): { ok: true } | { ok: false; reason: ReasonCode; error?: string } {
    if (this.agent.spawn?.allow === false) {
      return { ok: false, reason: "gate_denied", error: "spawn.allow is false" };
    }
    // If spawn policy exists and allow is explicitly required
    if (this.agent.spawn && this.agent.spawn.allow !== true && this.agent.spawn.allow !== undefined) {
      return { ok: false, reason: "gate_denied" };
    }

    const childTools = (args.tools as string[]) ?? [];
    const parentTools = this.parentTools();
    if (childTools.some((t) => !parentTools.includes(t))) {
      return { ok: false, reason: "gate_denied", error: "tool escalation" };
    }

    const childFs = args.filesystem as { write_scopes?: string[]; read_scopes?: string[] } | undefined;
    const parentFs = this.agent.permissions?.filesystem;
    if (childFs?.write_scopes) {
      const parents = parentFs?.write_scopes ?? [];
      if (childFs.write_scopes.some((s) => !scopeCovered(s, parents))) {
        return { ok: false, reason: "gate_denied", error: "write_scopes escalation" };
      }
    }
    if (childFs?.read_scopes && parentFs?.read_scopes) {
      if (childFs.read_scopes.some((s) => !scopeCovered(s, parentFs.read_scopes!))) {
        return { ok: false, reason: "gate_denied", error: "read_scopes escalation" };
      }
    }

    const childLimits = args.limits as { max_steps?: number; max_tool_calls?: number } | undefined;
    const maxSteps = this.agent.limits?.max_steps ?? 1000;
    const maxTools = this.agent.limits?.max_tool_calls ?? 1000;
    const remainingSteps = maxSteps - this.steps;
    const remainingCalls = maxTools - this.toolCalls;
    if (childLimits?.max_steps !== undefined && childLimits.max_steps > remainingSteps) {
      return { ok: false, reason: "gate_denied", error: "max_steps escalation" };
    }
    if (childLimits?.max_tool_calls !== undefined && childLimits.max_tool_calls > remainingCalls) {
      return { ok: false, reason: "gate_denied", error: "max_tool_calls escalation" };
    }

    if (args.spawn_nested === true || (args.spawn as { allow?: boolean })?.allow === true) {
      if (this.agent.spawn?.allow_nested !== true) {
        return { ok: false, reason: "gate_denied", error: "nested spawn denied" };
      }
    }

    return { ok: true };
  }

  /** Build a tighten-only child harness IR from spawn args. */
  private buildChildAgent(args: Record<string, unknown>): AgentIR {
    const childToolIds = (args.tools as string[]) ?? [];
    const maxSteps = this.agent.limits?.max_steps ?? 1000;
    const maxTools = this.agent.limits?.max_tool_calls ?? 1000;
    const remainingSteps = Math.max(1, maxSteps - this.steps);
    const remainingCalls = Math.max(1, maxTools - this.toolCalls);
    const childLimits = args.limits as { max_steps?: number; max_tool_calls?: number } | undefined;
    const childFs = args.filesystem as
      | { write_scopes?: string[]; read_scopes?: string[] }
      | undefined;

    return {
      spec: this.agent.spec,
      name: `${this.agent.name}/child`,
      state: { ...this.agent.state },
      tools: this.agent.tools.filter((t) => childToolIds.includes(t.id)),
      gates: this.agent.gates,
      limits: {
        max_steps: childLimits?.max_steps ?? remainingSteps,
        max_tool_calls: childLimits?.max_tool_calls ?? remainingCalls,
      },
      fallback_state: this.agent.fallback_state,
      safe_state: this.agent.safe_state,
      recovery: this.agent.recovery,
      permissions: {
        tools: childToolIds,
        filesystem: childFs ?? this.agent.permissions?.filesystem,
      },
      spawn: {
        allow: this.agent.spawn?.allow_nested === true,
        allow_nested: false,
        tighten_only: true,
      },
      counterbalance: this.agent.counterbalance,
    };
  }

  /**
   * When spawn args include `proposals`, run a nested FaustRuntime and append
   * child events to the parent log (with depth / spawn_id). Otherwise stub-only.
   */
  private async runNestedChild(
    args: Record<string, unknown>,
    spawnId: string,
  ): Promise<{ child_steps: number }> {
    const rawProposals = args.proposals;
    if (!Array.isArray(rawProposals) || rawProposals.length === 0) {
      return { child_steps: 0 };
    }
    const proposals = rawProposals as ModelProposal[];
    let pi = 0;
    const childAgent = this.buildChildAgent(args);
    const childToolIds = new Set((args.tools as string[]) ?? []);
    const childTools: Record<string, ToolHandler> = {};
    for (const id of childToolIds) {
      if (this.tools[id]) childTools[id] = this.tools[id]!;
    }
    const child = new FaustRuntime({
      agent: childAgent,
      propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
      tools: childTools,
      depth: this.depth + 1,
      spawnId,
      allowJudge: false,
    });
    await child.runLoop(childAgent.limits?.max_steps ?? 32);
    for (const cev of child.events) {
      this.seq += 1;
      const merged: Event = {
        ...cev,
        seq: this.seq,
        ts_logical: this.seq,
        depth: this.depth + 1,
        spawn_id: spawnId,
      };
      this.events.push(merged);
    }
    return { child_steps: child.events.length };
  }

  /** Governed observation path for effect verifies. */
  private async runObservation(
    observerId: string,
  ): Promise<{ ok: true; observation: Record<string, unknown> } | { ok: false }> {
    const observer = this.toolById(observerId);
    if (!observer || observer.read_only !== true) {
      this.emit({
        stage: "validate",
        verdict: "deny",
        reason: "capability_missing",
        tool: observerId,
        error: "observer missing or not read_only",
      });
      return { ok: false };
    }

    const allowed = this.agent.permissions?.tools;
    if (allowed && !allowed.includes(observerId)) {
      this.emit({
        stage: "authorize",
        verdict: "deny",
        reason: "capability_missing",
        tool: observerId,
      });
      return { ok: false };
    }

    const maxTools = this.agent.limits?.max_tool_calls ?? 1000;
    if (this.toolCalls >= maxTools) {
      this.emit({
        stage: "authorize",
        verdict: "deny",
        reason: "limit_exceeded",
        tool: observerId,
      });
      return { ok: false };
    }

    this.toolCalls += 1;
    let envelope: ToolResultEnvelope;
    try {
      envelope = await this.invokeNative(observerId, {});
    } catch (e) {
      this.emit({
        stage: "observe",
        verdict: "deny",
        reason: "tool_execution_failed",
        tool: observerId,
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false };
    }

    const outCheck = validateAgainstSchema(observer.output, envelope.output);
    if (!outCheck.ok) {
      this.emit({
        stage: "observe",
        verdict: "deny",
        reason: "output_schema_invalid",
        tool: observerId,
        error: "output schema validation failed",
      });
      return { ok: false };
    }

    this.emit({
      stage: "observe",
      verdict: "allow",
      tool: observerId,
      args: {},
      result: envelope.output,
    });
    return { ok: true, observation: envelope.output };
  }

  private async runRecovery(triggerReason: ReasonCode): Promise<void> {
    const recovery = this.agent.recovery;
    if (!recovery || this.recovering) {
      this.applyFallbackState();
      return;
    }
    if (recovery.on && recovery.on !== triggerReason) {
      this.applyFallbackState();
      return;
    }

    this.recovering = true;
    const action = {
      name: recovery.execute.tool,
      args: recovery.execute.args ?? {},
    };

    // Governed recovery execute
    this.emit({ stage: "propose", tool: action.name, args: action.args });

    const tool = this.toolById(action.name);
    if (!tool) {
      this.emit({
        stage: "validate",
        verdict: "deny",
        reason: "capability_missing",
        tool: action.name,
        args: action.args,
      });
      this.emit({ stage: "record", verdict: "deny", reason: "terminal_failure" });
      this.applyFallbackState();
      this.recovering = false;
      return;
    }

    const inCheck = validateAgainstSchema(tool.input, action.args);
    if (!inCheck.ok) {
      this.emit({
        stage: "validate",
        verdict: "deny",
        reason: "input_schema_invalid",
        tool: action.name,
        args: action.args,
        error: "input schema validation failed",
      });
      this.emit({ stage: "record", verdict: "deny", reason: "terminal_failure" });
      this.applyFallbackState();
      this.recovering = false;
      return;
    }
    this.emit({ stage: "validate", verdict: "allow", tool: action.name, args: action.args });
    this.emit({ stage: "authorize", verdict: "allow", tool: action.name, args: action.args });

    this.toolCalls += 1;
    let envelope: ToolResultEnvelope;
    try {
      envelope = await this.invokeNative(action.name, action.args);
    } catch (e) {
      this.emit({
        stage: "execute",
        verdict: "deny",
        reason: "tool_execution_failed",
        tool: action.name,
        args: action.args,
        error: e instanceof Error ? e.message : String(e),
      });
      this.emit({ stage: "record", verdict: "deny", reason: "terminal_failure" });
      this.applyFallbackState();
      this.recovering = false;
      return;
    }

    const outCheck = validateAgainstSchema(tool.output, envelope.output);
    if (!outCheck.ok) {
      this.emit({
        stage: "execute",
        verdict: "deny",
        reason: "output_schema_invalid",
        tool: action.name,
        args: action.args,
        error: "output schema validation failed",
      });
      this.emit({ stage: "record", verdict: "deny", reason: "terminal_failure" });
      this.applyFallbackState();
      this.recovering = false;
      return;
    }

    this.applyStateTransition(envelope.state_transition);
    this.emit({
      stage: "execute",
      verdict: "allow",
      tool: action.name,
      args: action.args,
      result: envelope.output,
    });

    const verified = await this.runOneVerify(recovery.verify, action, envelope.output);
    if (verified) {
      this.emit({ stage: "record", verdict: "allow", reason: "recovery_succeeded" });
      this.applyFallbackState();
    } else {
      this.emit({ stage: "record", verdict: "deny", reason: "terminal_failure" });
      this.applyFallbackState();
    }
    this.recovering = false;
  }

  private async enterSafeFlow(triggerReason: ReasonCode): Promise<void> {
    await this.runRecovery(triggerReason);
  }

  private async runVerifies(
    tool: ToolDef,
    action: { name: string; args: Record<string, unknown> },
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const verifies = tool.verify ?? [];
    for (const v of verifies) {
      const ok = await this.runOneVerify(v, action, result);
      if (!ok) return false;
    }
    if (verifies.length === 0) {
      this.emit({ stage: "verify", verdict: "allow" });
    }
    return true;
  }

  private async runOneVerify(
    v: Verify,
    action: { name: string; args: Record<string, unknown> },
    result: Record<string, unknown>,
  ): Promise<boolean> {
    if (v.kind === "judge") {
      if (!this.allowJudge) {
        throw new Error("judge verify forbidden in Track A");
      }
      if (!this.judge) {
        this.emit({
          stage: "verify",
          verdict: v.otherwise ?? "deny",
          reason: "verify_judge_invalid",
          tool: action.name,
          args: action.args,
        });
        return false;
      }
      const judgmentRaw = await this.judge(v.rubric, {
        action,
        result,
        state: this.agent.state,
      });
      if ("invalid" in judgmentRaw) {
        this.emit({
          stage: "verify",
          verdict: v.otherwise ?? "deny",
          reason: "verify_judge_invalid",
          tool: action.name,
          error: judgmentRaw.raw,
        });
        return false;
      }
      const snapshot: Snapshot = {
        action,
        state: this.agent.state,
        result,
        judgment: judgmentRaw,
      };
      if (!evalPredicate(v.require, snapshot)) {
        this.emit({
          stage: "verify",
          verdict: v.otherwise ?? "deny",
          reason: "verify_judge_failed",
          tool: action.name,
          result: judgmentRaw,
        });
        return false;
      }
      this.emit({ stage: "verify", verdict: "allow", tool: action.name, result: judgmentRaw });
      return true;
    }

    if (v.kind === "effect") {
      const obs = await this.runObservation(v.observe);
      if (!obs.ok) return false;
      const snapshot: Snapshot = {
        action,
        state: this.agent.state,
        result,
        observation: obs.observation,
      };
      if (!evalPredicate(v.require, snapshot)) {
        const verdict = v.otherwise ?? "safe_state";
        this.emit({
          stage: "verify",
          verdict,
          reason: "verify_effect_failed",
          tool: action.name,
          args: action.args,
          observation: obs.observation,
        });
        if (verdict === "safe_state" && !this.recovering) {
          await this.enterSafeFlow("verify_effect_failed");
        }
        return false;
      }
      this.emit({
        stage: "verify",
        verdict: "allow",
        tool: action.name,
        observation: obs.observation,
      });
      return true;
    }

    if (v.kind === "output") {
      return this.runOutputVerify(v, action, result);
    }

    const reason: ReasonCode =
      v.kind === "evidence" ? "verify_evidence_failed" : "verify_absence_failed";
    const snapshot: Snapshot = { action, state: this.agent.state, result };
    if (!evalPredicate(v.require, snapshot)) {
      const verdict = v.otherwise ?? "safe_state";
      this.emit({
        stage: "verify",
        verdict,
        reason,
        tool: action.name,
        args: action.args,
        result,
      });
      if (verdict === "safe_state" && !this.recovering) {
        await this.enterSafeFlow(reason);
      }
      return false;
    }
    this.emit({ stage: "verify", verdict: "allow", tool: action.name, result });
    return true;
  }

  private messageContentFrom(
    action: { name: string; args: Record<string, unknown> },
    result: Record<string, unknown>,
  ): string {
    if (typeof action.args.message === "string") return action.args.message;
    if (typeof result.message === "string") return result.message;
    return "";
  }

  private async runOutputVerify(
    v: VerifyOutput,
    action: { name: string; args: Record<string, unknown> },
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const message = buildMessageSnapshot(this.messageContentFrom(action, result));
    const snapshot: Snapshot = { action, state: this.agent.state, result, message };
    if (!evalPredicate(v.require, snapshot)) {
      const verdict = v.otherwise ?? "deny";
      this.emit({
        stage: "verify",
        verdict,
        reason: "verify_output_failed",
        tool: action.name,
        args: action.args,
        result,
        observation: { message },
      });
      if (verdict === "safe_state" && !this.recovering) {
        await this.enterSafeFlow("verify_output_failed");
      }
      return false;
    }
    this.emit({
      stage: "verify",
      verdict: "allow",
      tool: action.name,
      result,
      observation: { message },
    });
    return true;
  }

  private async runAgentOutputVerifies(content: string): Promise<boolean> {
    const verifies = this.agent.counterbalance?.output_verifies ?? [];
    if (verifies.length === 0) return true;
    const action = { name: "assistant.message", args: { message: content } };
    const result = { message: content };
    for (const v of verifies) {
      if (v.kind !== "output") continue;
      const ok = await this.runOutputVerify(v, action, result);
      if (!ok) return false;
    }
    return true;
  }

  async runLoop(maxIterations = 32): Promise<Event[]> {
    let consecutiveEmptyProposals = 0;
    for (let i = 0; i < maxIterations; i++) {
      if (!this.checkLimits()) break;
      this.steps += 1;
      this.applyTtlInvalidation();
      this.checkInterventionBudget();

      if (this.agent.counterbalance?.orientation?.emit_each_step === true) {
        this.emit({
          stage: "orient",
          verdict: "allow",
          observation: this.buildOrientationFrame(),
        });
      }

      const proposal = await this.propose();
      if (!proposal || proposal.type === "stop") {
        const stopMessage =
          proposal?.type === "stop" && proposal.message
            ? String(proposal.message)
            : undefined;
        if (stopMessage !== undefined) {
          const ok = await this.runAgentOutputVerifies(stopMessage);
          if (!ok) break;
        }
        this.emit({
          stage: "propose",
          verdict: "allow",
          ...(stopMessage
            ? { observation: { stop_message: stopMessage.slice(0, 500) } }
            : {}),
        });
        break;
      }
      if (proposal.type === "invalid") {
        consecutiveEmptyProposals += 1;
        this.emit({
          stage: "propose",
          verdict: "deny",
          reason: "empty_proposal",
          error: proposal.message ?? proposal.reason,
          observation: {
            invalid_reason: proposal.reason,
            stop_message: proposal.message ? String(proposal.message).slice(0, 500) : null,
          },
        });
        // Cap empty-proposal thrash even when continue_after_deny is on.
        if (this.denyIsTerminal() || consecutiveEmptyProposals >= 2) break;
        continue;
      }
      consecutiveEmptyProposals = 0;

      const action = { name: proposal.name, args: proposal.args };
      this.emit({
        stage: "propose",
        tool: action.name,
        args: action.args,
      });

      const tool = this.toolById(action.name);
      if (!tool) {
        this.emit({
          stage: "validate",
          verdict: "deny",
          reason: "capability_missing",
          tool: action.name,
          args: action.args,
        });
        if (this.denyIsTerminal()) break;
        continue;
      }

      const allowed = this.agent.permissions?.tools;
      if (allowed && !allowed.includes(action.name) && action.name !== "agent.spawn") {
        this.emit({
          stage: "validate",
          verdict: "deny",
          reason: "capability_missing",
          tool: action.name,
          args: action.args,
        });
        if (this.denyIsTerminal()) break;
        continue;
      }

      const inCheck = validateAgainstSchema(tool.input, action.args);
      if (!inCheck.ok) {
        this.emit({
          stage: "validate",
          verdict: "deny",
          reason: "input_schema_invalid",
          tool: action.name,
          args: action.args,
          error: "input schema validation failed",
        });
        if (this.denyIsTerminal()) break;
        continue;
      }

      this.emit({ stage: "validate", verdict: "allow", tool: action.name, args: action.args });

      const gateSnap: Snapshot = { action, state: this.agent.state };
      const gated = this.evalGates(gateSnap, this.agent.gates);
      if (!gated.ok) {
        this.emit({
          stage: "authorize",
          verdict: gated.verdict,
          reason: gated.reason,
          tool: action.name,
          args: action.args,
        });
        if (gated.verdict === "safe_state") {
          await this.enterSafeFlow("gate_denied");
          break;
        }
        if (this.denyIsTerminal()) break;
        continue;
      }

      if (action.name === "agent.spawn") {
        const child = this.compareChildEnvelope(action.args);
        if (!child.ok) {
          this.emit({
            stage: "authorize",
            verdict: "deny",
            reason: child.reason,
            tool: action.name,
            args: action.args,
            error: child.error,
          });
          if (this.denyIsTerminal()) break;
          continue;
        }
      }

      const seqCheck = this.checkSequences(action);
      if (!seqCheck.ok) {
        this.emit({
          stage: "authorize",
          verdict: "deny",
          reason: seqCheck.reason,
          failure: seqCheck.failure,
          tool: action.name,
          args: action.args,
        });
        if (this.denyIsTerminal()) break;
        continue;
      }

      const completionAuth = this.checkCompletion(action.name);
      if (!completionAuth.ok) {
        this.emit({
          stage: "authorize",
          verdict: "deny",
          reason: completionAuth.reason,
          failure: completionAuth.failure,
          tool: action.name,
          args: action.args,
        });
        if (this.denyIsTerminal()) break;
        continue;
      }

      this.emit({ stage: "authorize", verdict: "allow", tool: action.name, args: action.args });

      this.toolCalls += 1;

      let envelope: ToolResultEnvelope;
      try {
        envelope = await this.invokeNative(action.name, action.args);
      } catch (e) {
        this.emit({
          stage: "execute",
          verdict: "deny",
          reason: "tool_execution_failed",
          tool: action.name,
          args: action.args,
          error: e instanceof Error ? e.message : String(e),
        });
        if (this.denyIsTerminal()) break;
        continue;
      }

      const outCheck = validateAgainstSchema(tool.output, envelope.output);
      if (!outCheck.ok) {
        this.emit({
          stage: "execute",
          verdict: "deny",
          reason: "output_schema_invalid",
          tool: action.name,
          args: action.args,
          error: "output schema validation failed",
        });
        if (this.denyIsTerminal()) break;
        continue;
      }

      const checkpoint = this.checkCheckpointAuthority(action, envelope.state_transition);
      if (!checkpoint.ok) {
        this.emit({
          stage: "execute",
          verdict: "deny",
          reason: checkpoint.reason,
          tool: action.name,
          args: action.args,
          error: checkpoint.error,
          failure: checkpoint.failure,
        });
        if (this.denyIsTerminal()) break;
        continue;
      }

      this.applyStateTransition(envelope.state_transition);

      this.emit({
        stage: "execute",
        verdict: "allow",
        tool: action.name,
        args: action.args,
        result: envelope.output,
      });

      if (action.name === "agent.spawn") {
        const spawnId = `spawn-${this.seq}`;
        const nested = await this.runNestedChild(action.args, spawnId);
        if (nested.child_steps > 0) {
          // Annotate parent execute result with child event count (non-breaking for stub-only).
          const execEv = this.events[this.events.length - 1 - nested.child_steps];
          if (execEv && execEv.stage === "execute" && execEv.tool === "agent.spawn") {
            execEv.result = { ...envelope.output, child_events: nested.child_steps };
          }
        }
      }

      const verified = await this.runVerifies(tool, action, envelope.output);
      if (!verified) break;

      this.applyInvalidateAfter(action.name);
    }
    return this.events;
  }
}

export function eventsToJsonl(events: Event[]): string {
  return events.map((e) => canonicalJson(e)).join("\n") + "\n";
}
