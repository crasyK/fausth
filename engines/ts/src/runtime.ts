/**
 * Fausth engine — the governed exchange loop (normative text: docs/spec-v0.3.md).
 *
 * The engine knows no harness- or domain-specific names (D11). Everything it treats specially
 * is declared in the harness IR (channels, completion tool, checkpoints, …) or is one of the
 * contract tools specified in the spec (agent.spawn, harness.*).
 */
import {
  canonicalJson,
  compareCodePoints,
  deepEq,
  excerpt,
  sortCodePoints,
  stateHash,
  toCanonical,
} from "./canonical.js";
import {
  buildCheckpointKeyFailure,
  buildHarnessPatchFailure,
  buildMissingPriorAnyOfFailure,
  buildMissingPriorToolsFailure,
  buildNonCanonicalFailure,
  buildPredicateFailure,
  buildSpawnFailure,
  buildStateKeyFailure,
} from "./deny-failure.js";
import { evalPredicate } from "./predicates.js";
import { validateAgainstSchema } from "./schema-validate.js";
import { fallbackStateOf, normalizeAgentIr } from "./load.js";
import { parseScope, scopeContains } from "./scopes.js";
import type {
  AgentIR,
  DenyFailure,
  Event,
  Gate,
  HarnessPatch,
  HarnessPatchCode,
  ModelProposal,
  Predicate,
  ReasonCode,
  RecordedToolCall,
  Snapshot,
  SpawnDimension,
  StateTransition,
  ToolDef,
  Verdict,
  Verify,
  VerifyOutput,
} from "./types.js";
import {
  DECLINE_TOOL,
  PATCH_TOOL,
  REFLECT_TOOL,
  REFLECTION_TOOLS,
  SPAWN_TOOL,
  buildMessageSnapshot,
} from "./types.js";
import {
  applyHarnessPatch,
  harnessIrHash,
  parseHarnessPatch,
  parseSkillsPatchDecline,
  parseSkillsReflectDetailed,
  validatePatchSecurity,
} from "./harness-patch.js";

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { state: Record<string, unknown> },
) => Promise<unknown> | unknown;

/** Judge (live only). The engine validates the result (spec-v0.3 §7). */
export type JudgeFn = (
  rubric: string,
  context: Record<string, unknown>,
) => Promise<{ score: number; reason: string } | { invalid: true; raw: string } | unknown>;

/**
 * Thrown by recorded user-channel handlers (spec-v0.3 §15.2) to report a structured
 * transcript failure instead of a host error.
 */
export class TranscriptError extends Error {
  constructor(
    readonly code: "mismatch" | "exhausted",
    readonly callSeq: number,
  ) {
    super(`recorded transcript ${code} at call ${callSeq}`);
    this.name = "TranscriptError";
  }
}

/** Shared recorded-transcript cursor (parent and children consume one transcript). */
export class TranscriptCursor {
  idx = 0;
  constructor(readonly entries: RecordedToolCall[]) {}
}

export type RuntimeOptions = {
  agent: AgentIR;
  propose: () => Promise<ModelProposal | null>;
  /**
   * Host handlers by tool id: world-channel tools, and user-channel tools ONLY when they are
   * backed by a user-channel binding (recorded answers / simulator / human). Never pass a world
   * stub for a `channel: user` tool (spec-v0.3 §9).
   */
  tools: Record<string, ToolHandler>;
  judge?: JudgeFn;
  /** Judge verifies run only when this is true and `judge` is set (never in Track A). */
  allowJudge?: boolean;
  /** Recorded transcript; when present (even empty) the run is in recorded-transcript mode. */
  recordedToolResults?: RecordedToolCall[];
  /** Nesting depth for spawn children (default 0). */
  depth?: number;
  /** Parent spawn id when this runtime is a child reaction. */
  spawnId?: string;
  /** Internal: transcript cursor shared with a parent. */
  transcript?: TranscriptCursor;
};

type Action = { name: string; args: Record<string, unknown> };
type Origin = "model" | "recovery";
type Outcome = "success" | "complete" | "denied" | "safe_state";
type PartialEvent = Omit<Event, "seq" | "ts_logical" | "state_hash">;
type Provenance = { status: "current" | "stale" | "contradicted" | "unknown"; updated_at_step: number };

const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_OBSERVATION_CHARS = 8000;
const EXCERPT_CHARS = 500;
const REDACTED = "[redacted]";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Fresh = not 0, false, null or "" (spec-v0.3 §8.4). */
function isFreshValue(v: unknown): boolean {
  return !(v === 0 || v === false || v === null || v === "" || v === undefined);
}

type Envelope = { output: Record<string, unknown>; transition?: StateTransition };

/** Spec-v0.3 §6.3.3: `{output, state_transition?}` or a bare object without `output`. */
function readEnvelope(raw: unknown): Envelope | null {
  if (!isPlainObject(raw)) return null;
  if ("_state_patch" in raw) return null;
  if (!("output" in raw)) {
    if ("state_transition" in raw) return null;
    return { output: raw };
  }
  for (const k of Object.keys(raw)) {
    if (k !== "output" && k !== "state_transition") return null;
  }
  if (!isPlainObject(raw.output)) return null;
  const st = raw.state_transition;
  if (st === undefined || st === null) return { output: raw.output };
  if (!isPlainObject(st)) return null;
  for (const k of Object.keys(st)) {
    if (k !== "set" && k !== "remove") return null;
  }
  if (st.set !== undefined && !isPlainObject(st.set)) return null;
  if (st.remove !== undefined) {
    if (!Array.isArray(st.remove) || st.remove.some((x) => typeof x !== "string")) return null;
  }
  const transition: StateTransition = {};
  if (st.set !== undefined) transition.set = st.set as Record<string, unknown>;
  if (st.remove !== undefined) transition.remove = st.remove as string[];
  return { output: raw.output, transition };
}

type SpawnPacket = {
  tools: string[];
  write_scopes?: string[];
  read_scopes?: string[];
  max_steps?: number;
  max_tool_calls?: number;
  nested: boolean;
  proposals?: unknown[];
};

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Spawn packet parse (spec-v0.3 §10); null = malformed. */
function parseSpawnPacket(args: Record<string, unknown>): SpawnPacket | null {
  const tools = args.tools;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || t.length === 0)) return null;
  const packet: SpawnPacket = { tools: tools as string[], nested: false };
  if (args.filesystem !== undefined) {
    if (!isPlainObject(args.filesystem)) return null;
    for (const k of Object.keys(args.filesystem)) {
      if (k !== "write_scopes" && k !== "read_scopes") return null;
    }
    for (const k of ["write_scopes", "read_scopes"] as const) {
      const v = args.filesystem[k];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !parseScope(s).ok)) return null;
      packet[k] = v as string[];
    }
  }
  if (args.limits !== undefined) {
    if (!isPlainObject(args.limits)) return null;
    for (const k of Object.keys(args.limits)) {
      if (k !== "max_steps" && k !== "max_tool_calls") return null;
    }
    for (const k of ["max_steps", "max_tool_calls"] as const) {
      const v = args.limits[k];
      if (v === undefined) continue;
      if (!isNonNegInt(v)) return null;
      packet[k] = v;
    }
  }
  if (args.spawn_nested !== undefined) {
    if (typeof args.spawn_nested !== "boolean") return null;
    if (args.spawn_nested) packet.nested = true;
  }
  if (args.spawn !== undefined) {
    if (!isPlainObject(args.spawn)) return null;
    if (args.spawn.allow !== undefined && typeof args.spawn.allow !== "boolean") return null;
    if (args.spawn.allow === true) packet.nested = true;
  }
  if (args.proposals !== undefined) {
    if (!Array.isArray(args.proposals) || args.proposals.some((p) => !isPlainObject(p))) return null;
    packet.proposals = args.proposals;
  }
  return packet;
}

/** Recorded child proposal (same shape as model.jsonl lines). */
function toProposal(raw: unknown): ModelProposal {
  const o = (isPlainObject(raw) ? raw : {}) as Record<string, unknown>;
  if (o.type === "stop") {
    return typeof o.message === "string" ? { type: "stop", message: o.message } : { type: "stop" };
  }
  if (o.type === "invalid") {
    return {
      type: "invalid",
      reason: typeof o.reason === "string" ? o.reason : "invalid",
      ...(typeof o.message === "string" ? { message: o.message } : {}),
    };
  }
  return {
    type: "tool",
    name: String(o.name ?? o.tool ?? ""),
    args: (isPlainObject(o.args) ? o.args : {}) as Record<string, unknown>,
  };
}

export class FaustRuntime {
  agent: AgentIR;
  events: Event[] = [];
  private seq = 0;
  private steps = 0;
  private toolCalls = 0;
  private readonly propose: RuntimeOptions["propose"];
  private readonly tools: Record<string, ToolHandler>;
  private readonly judge?: JudgeFn;
  private readonly allowJudge: boolean;
  private readonly transcript?: TranscriptCursor;
  private readonly depth: number;
  private readonly spawnId?: string;
  private readonly initialState: Record<string, unknown>;
  private readonly declaredKeys: Set<string>;
  private provenance = new Map<string, Provenance>();
  /** Tools whose calls executed AND passed every verify (D8). */
  private readonly succeeded = new Set<string>();
  /** Denied attempts per contract reflection tool (spec-v0.3 §12). */
  private readonly reflectionDenials = new Map<string, number>();
  private budgetEmitted = false;
  private recovering = false;

  constructor(opts: RuntimeOptions) {
    const agent = normalizeAgentIr(structuredClone(opts.agent));
    if (!isPlainObject(agent.state)) agent.state = {};
    if (!Array.isArray(agent.tools)) agent.tools = [];
    this.agent = agent;
    this.initialState = structuredClone(agent.state);
    this.declaredKeys = new Set(Object.keys(agent.state));
    this.propose = opts.propose;
    this.tools = opts.tools;
    this.judge = opts.judge;
    this.allowJudge = opts.allowJudge ?? false;
    this.transcript =
      opts.transcript ??
      (opts.recordedToolResults !== undefined ? new TranscriptCursor(opts.recordedToolResults) : undefined);
    this.depth = opts.depth ?? 0;
    this.spawnId = opts.spawnId;
    const declared = agent.counterbalance?.memory_provenance ?? {};
    for (const [key, value] of Object.entries(agent.state)) {
      const d = declared[key];
      this.provenance.set(key, {
        status: d?.status ?? (isFreshValue(value) ? "current" : "stale"),
        updated_at_step: d?.updated_at_step ?? 0,
      });
    }
  }

  // ---------------------------------------------------------------- events

  private emit(partial: PartialEvent): Event {
    this.seq += 1;
    const ev: Event = {
      seq: this.seq,
      ts_logical: this.seq,
      state_hash: stateHash(this.agent.state),
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
    if (partial.harness_hash_before !== undefined) ev.harness_hash_before = partial.harness_hash_before;
    if (partial.harness_hash_after !== undefined) ev.harness_hash_after = partial.harness_hash_after;
    this.events.push(ev);
    return ev;
  }

  // ---------------------------------------------------------------- IR helpers

  private toolById(id: string): ToolDef | undefined {
    return this.agent.tools.find((t) => t.id === id);
  }

  private maxSteps(): number {
    return this.agent.limits?.max_steps ?? DEFAULT_LIMIT;
  }

  private maxToolCalls(): number {
    return this.agent.limits?.max_tool_calls ?? DEFAULT_LIMIT;
  }

  private maxObservationChars(): number {
    return this.agent.limits?.max_observation_chars ?? DEFAULT_MAX_OBSERVATION_CHARS;
  }

  /** D5: absent ⇒ all declared tools; [] ⇒ none. */
  private isPermitted(id: string): boolean {
    const p = this.agent.permissions?.tools;
    return p === undefined ? this.agent.tools.some((t) => t.id === id) : p.includes(id);
  }

  private permittedTools(): string[] {
    return sortCodePoints(this.agent.tools.map((t) => t.id).filter((id) => this.isPermitted(id)));
  }

  private continueAfterDeny(): boolean {
    return this.agent.limits?.continue_after_deny === true;
  }

  private checkpoints() {
    return this.agent.counterbalance?.checkpoints ?? [];
  }

  // ---------------------------------------------------------------- world feedback (§14)

  private secretValues(): string[] {
    const values = [...new Set(this.agent.permissions?.secrets?.values ?? [])].filter((v) => v.length > 0);
    return values.sort((a, b) => (b.length !== a.length ? b.length - a.length : compareCodePoints(a, b)));
  }

  private sanitizeString(s: string): string {
    let out = s;
    for (const secret of this.secretValues()) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return excerpt(out, this.maxObservationChars());
  }

  private sanitize(value: unknown): unknown {
    if (typeof value === "string") return this.sanitizeString(value);
    if (Array.isArray(value)) return value.map((v) => this.sanitize(v));
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.sanitize(v);
      return out;
    }
    return value;
  }

  // ---------------------------------------------------------------- invocation (§15.1)

  private async invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; raw: unknown } | { ok: false; failure: DenyFailure; error?: string }> {
    if (this.transcript) {
      const cur = this.transcript;
      const expected = cur.idx + 1;
      const entry = cur.entries[cur.idx];
      if (!entry) {
        return { ok: false, failure: { kind: "transcript", code: "exhausted", call_seq: expected } };
      }
      if (entry.call_seq !== expected || entry.tool !== name || !deepEq(entry.args ?? {}, args)) {
        return { ok: false, failure: { kind: "transcript", code: "mismatch", call_seq: expected } };
      }
      cur.idx += 1;
      return { ok: true, raw: entry.result };
    }
    const handler = this.tools[name];
    if (typeof handler !== "function") return { ok: false, failure: { kind: "host_error" } };
    try {
      return { ok: true, raw: await handler(args, { state: structuredClone(this.agent.state) }) };
    } catch (e) {
      if (e instanceof TranscriptError) {
        return { ok: false, failure: { kind: "transcript", code: e.code, call_seq: e.callSeq } };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, failure: { kind: "host_error" }, ...(msg ? { error: this.sanitizeString(msg) } : {}) };
    }
  }

  /** §9: user channel bound = recorded-transcript mode or a host handler for the tool. */
  private userChannelBound(id: string): boolean {
    return this.transcript !== undefined || typeof this.tools[id] === "function";
  }

  // ---------------------------------------------------------------- run loop (§5)

  private checkLimits(): boolean {
    if (this.steps >= this.maxSteps() || this.toolCalls >= this.maxToolCalls()) {
      this.emit({ stage: "authorize", verdict: "deny", reason: "limit_exceeded" });
      return false;
    }
    return true;
  }

  async runLoop(maxIterations = 32): Promise<Event[]> {
    let consecutiveInvalid = 0;
    for (let i = 0; i < maxIterations; i++) {
      if (!this.checkLimits()) break;
      this.steps += 1;
      this.applyTtlInvalidation();
      this.checkInterventionBudget();
      if (this.agent.counterbalance?.orientation?.emit_each_step === true) {
        this.emit({ stage: "orient", verdict: "allow", observation: this.buildOrientationFrame() });
      }

      const proposal = await this.propose();
      if (!proposal || proposal.type === "stop") {
        const m =
          proposal?.type === "stop" && typeof proposal.message === "string" && proposal.message.length > 0
            ? proposal.message
            : undefined;
        this.emit({
          stage: "propose",
          verdict: "allow",
          ...(m !== undefined ? { observation: { stop_message: excerpt(m, EXCERPT_CHARS) } } : {}),
        });
        if (m !== undefined && (this.agent.counterbalance?.output_verifies?.length ?? 0) > 0) {
          const verdict = await this.runAgentOutputVerifies(m);
          if (verdict === "deny" && this.continueAfterDeny()) continue;
          if (verdict === "safe_state") await this.safeFlow("verify_output_failed");
        }
        break;
      }

      if (proposal.type === "invalid") {
        consecutiveInvalid += 1;
        const text = typeof proposal.message === "string" ? proposal.message : undefined;
        this.emit({
          stage: "propose",
          verdict: "deny",
          reason: "empty_proposal",
          observation: {
            invalid_reason: excerpt(String(proposal.reason ?? ""), EXCERPT_CHARS),
            stop_message: text !== undefined ? excerpt(text, EXCERPT_CHARS) : null,
          },
        });
        if (!this.continueAfterDeny() || consecutiveInvalid >= 2) break;
        continue;
      }

      consecutiveInvalid = 0;
      const outcome = await this.processAction(
        { name: String(proposal.name), args: proposal.args as Record<string, unknown> },
        "model",
      );
      if (outcome === "complete" || outcome === "safe_state") break;
      if (outcome === "denied" && !this.continueAfterDeny()) break;
    }
    return this.events;
  }

  // ---------------------------------------------------------------- one action (§6)

  private async processAction(action: Action, origin: Origin): Promise<Outcome> {
    // propose (§5.3)
    const canon = toCanonical(action.args, "$.args");
    if (!canon.ok) {
      this.emit({
        stage: "propose",
        verdict: "deny",
        reason: "input_schema_invalid",
        tool: action.name,
        failure: buildNonCanonicalFailure(canon.path),
      });
      return "denied";
    }
    const args = canon.value as Record<string, unknown>;
    const act: Action = { name: action.name, args };
    this.emit({
      stage: "propose",
      tool: act.name,
      args,
      ...(origin === "recovery" ? { reason: "recovery_attempt" as const } : {}),
    });

    // validate (§6.1)
    const tool = this.toolById(act.name);
    const deny = (stage: "validate" | "authorize" | "execute", reason: ReasonCode, failure?: DenyFailure, verdict: Verdict = "deny") => {
      this.emit({ stage, verdict, reason, tool: act.name, args, ...(failure ? { failure } : {}) });
    };
    if (!tool || !this.isPermitted(act.name)) {
      deny("validate", "capability_missing");
      return "denied";
    }
    if ((tool.channel ?? "world") === "user" && !this.userChannelBound(tool.id)) {
      deny("validate", "capability_missing", { kind: "channel_unbound", channel: "user" });
      return "denied";
    }
    const reflection = (REFLECTION_TOOLS as readonly string[]).includes(act.name);
    if (!isPlainObject(args)) {
      if (reflection) this.noteReflectionDenial(act.name);
      deny("validate", "input_schema_invalid");
      return "denied";
    }
    const inCheck = validateAgainstSchema(tool.input, args);
    if (!inCheck.ok) {
      if (inCheck.compileError) {
        deny("validate", "schema_invalid");
        return "denied";
      }
      if (reflection) this.noteReflectionDenial(act.name);
      deny("validate", "input_schema_invalid");
      return "denied";
    }
    this.emit({ stage: "validate", verdict: "allow", tool: act.name, args });

    // authorize (§6.2)
    const gated = this.evalGates({ action: act, state: this.agent.state }, this.agent.gates);
    if (!gated.ok) {
      deny("authorize", "gate_denied", undefined, gated.verdict);
      if (gated.verdict === "safe_state") {
        if (origin === "recovery" || this.recovering) return "denied";
        await this.safeFlow("gate_denied");
        return "safe_state";
      }
      return "denied";
    }

    let spawnPacket: SpawnPacket | undefined;
    if (act.name === SPAWN_TOOL) {
      const s = this.checkSpawn(args);
      if (!s.ok) {
        deny("authorize", s.reason, s.failure);
        return "denied";
      }
      spawnPacket = s.packet;
    }

    let contractEffect: ContractEffect | undefined;
    if (reflection) {
      const c = this.checkContractTool(act);
      if (!c.ok) {
        this.noteReflectionDenial(act.name);
        deny("authorize", c.reason, buildHarnessPatchFailure(c.code));
        return "denied";
      }
      contractEffect = c.effect;
    }

    const seq = this.checkSequences(act);
    if (!seq.ok) {
      deny("authorize", "sequence_requirement_failed", seq.failure);
      return "denied";
    }

    const completion = this.checkCompletion(act.name);
    if (!completion.ok) {
      deny("authorize", "completion_gate_failed", completion.failure);
      return "denied";
    }

    const cpReq = this.checkCheckpointRequest(act);
    if (cpReq) {
      deny("authorize", "checkpoint_authority_failed", buildCheckpointKeyFailure(cpReq));
      return "denied";
    }

    if (this.toolCalls >= this.maxToolCalls()) {
      deny("authorize", "limit_exceeded");
      return "denied";
    }
    this.emit({ stage: "authorize", verdict: "allow", tool: act.name, args });

    // execute (§6.3)
    this.toolCalls += 1;
    const invoked = await this.invoke(act.name, args);
    if (!invoked.ok) {
      this.emit({
        stage: "execute",
        verdict: "deny",
        reason: "tool_execution_failed",
        tool: act.name,
        args,
        failure: invoked.failure,
        ...(invoked.error !== undefined ? { error: invoked.error } : {}),
      });
      return "denied";
    }
    const env = readEnvelope(invoked.raw);
    if (!env) {
      deny("execute", "output_schema_invalid", { kind: "malformed_envelope" });
      return "denied";
    }
    const outCanon = toCanonical(env.output, "$.result");
    if (!outCanon.ok) {
      deny("execute", "output_schema_invalid", buildNonCanonicalFailure(outCanon.path));
      return "denied";
    }
    let transition: StateTransition | undefined;
    if (env.transition) {
      const tCanon = toCanonical(env.transition, "$.state_transition");
      if (!tCanon.ok) {
        deny("execute", "output_schema_invalid", buildNonCanonicalFailure(tCanon.path));
        return "denied";
      }
      transition = tCanon.value as StateTransition;
    }
    const output = this.sanitize(outCanon.value) as Record<string, unknown>;
    const outCheck = validateAgainstSchema(tool.output, output);
    if (!outCheck.ok) {
      deny("execute", "output_schema_invalid");
      return "denied";
    }
    const authority = this.checkTransitionAuthority(act.name, transition);
    if (authority) {
      deny("execute", authority.reason, authority.failure);
      return "denied";
    }

    const preState = this.agent.state;
    this.agent.state = this.applyTransition(preState, transition);
    this.emit({ stage: "execute", verdict: "allow", tool: act.name, args, result: output });

    if (spawnPacket && spawnPacket.proposals && spawnPacket.proposals.length > 0) {
      await this.runChild(spawnPacket, `spawn-${this.seq}`);
    }

    // verify (§6.4)
    const verifies: Verify[] = [...(tool.verify ?? [])];
    if (origin === "recovery" && this.agent.recovery?.verify) verifies.push(this.agent.recovery.verify);
    if (verifies.length === 0) {
      this.emit({ stage: "verify", verdict: "allow" });
    }
    for (const v of verifies) {
      const r = await this.evaluateVerify(v, act, output);
      if (r.pass) {
        this.emit(r.event);
        continue;
      }
      this.agent.state = preState; // discard the provisional transition (D8)
      this.emit(r.event);
      if (r.verdict === "safe_state" && origin !== "recovery" && !this.recovering) {
        await this.safeFlow(r.event.reason as ReasonCode);
        return "safe_state";
      }
      return "denied";
    }

    // commit (§6.5)
    this.commitProvenance(transition);
    this.succeeded.add(act.name);
    if (contractEffect) this.applyContractEffect(act, contractEffect);
    this.applyActionInvalidation(act.name);
    if (origin !== "recovery" && this.agent.counterbalance?.completion?.tool === act.name) {
      this.emit({ stage: "record", verdict: "allow", reason: "run_complete", tool: act.name });
      return "complete";
    }
    return "success";
  }

  // ---------------------------------------------------------------- authorize helpers

  private evalGates(
    snapshot: Snapshot,
    gates: Gate[] | undefined,
  ): { ok: true } | { ok: false; verdict: Verdict } {
    for (const g of gates ?? []) {
      if (g.when && !evalPredicate(g.when, snapshot)) continue;
      if (!evalPredicate(g.require, snapshot)) {
        return { ok: false, verdict: g.otherwise === "safe_state" ? "safe_state" : "deny" };
      }
    }
    return { ok: true };
  }

  private checkSpawn(
    args: Record<string, unknown>,
  ):
    | { ok: true; packet: SpawnPacket }
    | { ok: false; reason: ReasonCode; failure: DenyFailure } {
    const escalation = (dimension: SpawnDimension) => ({
      ok: false as const,
      reason: "gate_denied" as ReasonCode,
      failure: buildSpawnFailure("escalation", dimension),
    });
    if (this.agent.spawn?.allow !== true) {
      return { ok: false, reason: "gate_denied", failure: buildSpawnFailure("not_allowed") };
    }
    const packet = parseSpawnPacket(args);
    if (!packet) return { ok: false, reason: "schema_invalid", failure: buildSpawnFailure("malformed") };
    if (packet.tools.some((t) => !this.isPermitted(t))) return escalation("tools");
    const fs = this.agent.permissions?.filesystem;
    const covered = (child: string, parents: string[] | undefined) => {
      const c = parseScope(child);
      if (!c.ok) return false;
      return (parents ?? []).some((p) => {
        const ps = parseScope(p);
        return ps.ok && scopeContains(ps.scope, c.scope);
      });
    };
    if (packet.write_scopes && packet.write_scopes.some((s) => !covered(s, fs?.write_scopes))) {
      return escalation("write_scopes");
    }
    if (packet.read_scopes && fs?.read_scopes && packet.read_scopes.some((s) => !covered(s, fs.read_scopes))) {
      return escalation("read_scopes");
    }
    if (packet.max_steps !== undefined && packet.max_steps > this.maxSteps() - this.steps) {
      return escalation("max_steps");
    }
    if (packet.max_tool_calls !== undefined && packet.max_tool_calls > this.maxToolCalls() - this.toolCalls - 1) {
      return escalation("max_tool_calls");
    }
    if (packet.nested && this.agent.spawn?.allow_nested !== true) return escalation("nested");
    return { ok: true, packet };
  }

  private noteReflectionDenial(tool: string): void {
    this.reflectionDenials.set(tool, (this.reflectionDenials.get(tool) ?? 0) + 1);
  }

  private checkContractTool(
    act: Action,
  ):
    | { ok: true; effect: ContractEffect }
    | { ok: false; reason: "harness_patch_invalid" | "harness_patch_denied"; code: HarnessPatchCode } {
    const invalid = (code: HarnessPatchCode) => ({ ok: false as const, reason: "harness_patch_invalid" as const, code });
    if (REFLECTION_TOOLS.some((t) => this.succeeded.has(t))) return invalid("reflection_done");
    if ((this.reflectionDenials.get(act.name) ?? 0) >= 1) return invalid("attempt_cap");
    if (act.name === DECLINE_TOOL) {
      const d = parseSkillsPatchDecline(act.args);
      if (!d) return invalid("invalid_decline");
      return { ok: true, effect: { kind: "decline", reason: d.reason, note: d.note } };
    }
    let patch: HarnessPatch | null;
    let fromReflect = false;
    if (act.name === REFLECT_TOOL) {
      const r = parseSkillsReflectDetailed(act.args);
      if (!r.ok) return invalid(r.code);
      if (r.reflect.disposition === "decline") {
        return {
          ok: true,
          effect: { kind: "decline", reason: r.reflect.reason, note: r.reflect.note, reflect: true },
        };
      }
      patch = r.reflect.patch;
      fromReflect = true;
    } else {
      patch = parseHarnessPatch(act.args);
      if (!patch) return invalid("malformed_patch");
    }
    const sec = validatePatchSecurity(this.agent, patch);
    if (!sec.ok) return { ok: false, reason: sec.reason, code: sec.code };
    return { ok: true, effect: { kind: "patch", patch, reflect: fromReflect } };
  }

  private checkSequences(act: Action): { ok: true } | { ok: false; failure: DenyFailure } {
    const snap: Snapshot = { action: act, state: this.agent.state };
    for (const seq of this.agent.counterbalance?.sequences ?? []) {
      if (seq.action !== act.name) continue;
      const missing = (seq.require_prior_tools ?? []).filter((t) => !this.succeeded.has(t));
      if (missing.length > 0) return { ok: false, failure: buildMissingPriorToolsFailure(missing) };
      const anyOf = seq.require_prior_any_of ?? [];
      if (anyOf.length > 0 && !anyOf.some((t) => this.succeeded.has(t))) {
        return { ok: false, failure: buildMissingPriorAnyOfFailure(anyOf) };
      }
      if (seq.require_state && !evalPredicate(seq.require_state, snap)) {
        return { ok: false, failure: buildPredicateFailure(seq.require_state, snap, this.checkpoints()) };
      }
    }
    return { ok: true };
  }

  private completionSnapshot(name: string): Snapshot {
    return { action: { name, args: {} }, state: this.agent.state };
  }

  private checkCompletion(name: string): { ok: true } | { ok: false; failure: DenyFailure } {
    const completion = this.agent.counterbalance?.completion;
    if (!completion || completion.tool !== name || !completion.require) return { ok: true };
    const snap = this.completionSnapshot(name);
    if (evalPredicate(completion.require, snap)) return { ok: true };
    return { ok: false, failure: buildPredicateFailure(completion.require, snap, this.checkpoints()) };
  }

  /** D9 on the request: a checkpoint tool's `args.set` keys ⊆ its allow_set_keys. */
  private checkCheckpointRequest(act: Action): string | null {
    const cp = this.checkpoints().find((c) => c.tool === act.name);
    if (!cp || !isPlainObject(act.args.set)) return null;
    for (const key of sortCodePoints(Object.keys(act.args.set))) {
      if (!cp.allow_set_keys.includes(key)) return key;
    }
    return null;
  }

  /** D9 on the transition (pre-commit): declared keys only; checkpoint keys only by owners. */
  private checkTransitionAuthority(
    toolId: string,
    transition: StateTransition | undefined,
  ): { reason: ReasonCode; failure: DenyFailure } | null {
    if (!transition) return null;
    const keys = [...sortCodePoints(Object.keys(transition.set ?? {})), ...(transition.remove ?? [])];
    const own = this.checkpoints().find((c) => c.tool === toolId);
    for (const key of keys) {
      if (!this.declaredKeys.has(key)) {
        return { reason: "state_write_denied", failure: buildStateKeyFailure(key) };
      }
      if (own) {
        if (!own.allow_set_keys.includes(key)) {
          return { reason: "checkpoint_authority_failed", failure: buildCheckpointKeyFailure(key) };
        }
      } else if (this.checkpoints().some((c) => c.allow_set_keys.includes(key))) {
        return { reason: "checkpoint_authority_failed", failure: buildCheckpointKeyFailure(key) };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- state & provenance (§8.4)

  private applyTransition(
    state: Record<string, unknown>,
    transition: StateTransition | undefined,
  ): Record<string, unknown> {
    if (!transition) return state;
    const next = { ...state };
    for (const [k, v] of Object.entries(transition.set ?? {})) next[k] = v;
    for (const k of transition.remove ?? []) delete next[k];
    return next;
  }

  private commitProvenance(transition: StateTransition | undefined): void {
    if (!transition) return;
    for (const [k, v] of Object.entries(transition.set ?? {})) {
      this.provenance.set(k, { status: isFreshValue(v) ? "current" : "stale", updated_at_step: this.steps });
    }
    for (const k of transition.remove ?? []) {
      this.provenance.set(k, { status: "stale", updated_at_step: this.steps });
    }
  }

  private markStale(keys: string[]): void {
    const next = { ...this.agent.state };
    for (const k of keys) {
      next[k] = 0;
      this.provenance.set(k, { status: "stale", updated_at_step: this.steps });
    }
    this.agent.state = next;
  }

  private applyActionInvalidation(actionName: string): void {
    const keys: string[] = [];
    let matched = false;
    for (const rule of this.agent.counterbalance?.invalidate_after ?? []) {
      if (rule.action !== actionName) continue;
      matched = true;
      for (const k of rule.memory_keys ?? []) if (!keys.includes(k)) keys.push(k);
    }
    if (!matched) return;
    this.markStale(keys);
    this.emit({
      stage: "record",
      verdict: "allow",
      reason: "memory_stale",
      tool: actionName,
      result: { invalidated: sortCodePoints(keys) },
    });
  }

  /** TTL: once per staleness transition; fresh through step updated_at_step + N. */
  private applyTtlInvalidation(): void {
    for (const rule of this.agent.counterbalance?.invalidate_after ?? []) {
      const n = rule.ttl_steps;
      if (rule.action !== undefined || n === undefined || !Number.isInteger(n) || n < 1) continue;
      const due = (rule.memory_keys ?? []).filter((k) => {
        const p = this.provenance.get(k);
        return p !== undefined && p.status === "current" && this.steps - p.updated_at_step > n;
      });
      if (due.length === 0) continue;
      const keys = [...new Set(due)];
      this.markStale(keys);
      this.emit({
        stage: "record",
        verdict: "allow",
        reason: "memory_stale",
        result: { invalidated: sortCodePoints(keys), ttl_steps: n },
      });
    }
  }

  /** §8.7: telemetry once, at the first iteration where steps_used > max_activations. */
  private checkInterventionBudget(): void {
    const budget = this.agent.counterbalance?.intervention_budget;
    if (!budget || this.budgetEmitted) return;
    if ((budget.window ?? "run") !== "run") return;
    if (!Number.isInteger(budget.max_activations) || budget.max_activations < 1) return;
    if (this.steps > budget.max_activations) {
      this.budgetEmitted = true;
      this.emit({
        stage: "record",
        verdict: "allow",
        reason: "budget_exceeded",
        result: { max_activations: budget.max_activations, activations: this.steps, window: "run" },
      });
    }
  }

  // ---------------------------------------------------------------- orientation (§8.5)

  private buildOrientationFrame(): Record<string, unknown> {
    const cb = this.agent.counterbalance ?? {};
    const sequence_blockers: Record<string, unknown>[] = [];
    for (const s of cb.sequences ?? []) {
      const prior = s.require_prior_tools ?? [];
      const anyOf = s.require_prior_any_of ?? [];
      if (prior.length === 0 && anyOf.length === 0) continue;
      const missingPrior = sortCodePoints(prior.filter((t) => !this.succeeded.has(t)));
      const missingAny = anyOf.length > 0 && !anyOf.some((t) => this.succeeded.has(t)) ? sortCodePoints(anyOf) : [];
      if (missingPrior.length === 0 && missingAny.length === 0) continue;
      sequence_blockers.push({
        action: s.action,
        ...(missingPrior.length ? { missing_prior_tools: missingPrior } : {}),
        ...(missingAny.length ? { missing_prior_any_of: missingAny } : {}),
      });
    }
    const freshness: Record<string, number> = {};
    for (const rule of cb.invalidate_after ?? []) {
      for (const key of rule.memory_keys ?? []) {
        freshness[key] = this.provenance.get(key)?.status === "current" ? 1 : 0;
      }
    }
    const frame: Record<string, unknown> = {
      permitted_tools: this.permittedTools(),
      sequence_blockers,
      freshness,
    };
    if (cb.completion) {
      const paths: string[] = [];
      this.collectPaths(cb.completion.require, paths);
      frame.completion = {
        tool: cb.completion.tool,
        require_paths: sortCodePoints(new Set(paths)),
        ready: this.checkCompletion(cb.completion.tool).ok ? 1 : 0,
      };
    }
    return frame;
  }

  private collectPaths(p: Predicate | undefined, out: string[]): void {
    if (!p) return;
    if ("path" in p) out.push(p.path);
    if ("all" in p) for (const x of p.all) this.collectPaths(x, out);
    if ("any" in p) for (const x of p.any) this.collectPaths(x, out);
    if ("not" in p) this.collectPaths(p.not, out);
  }

  // ---------------------------------------------------------------- verifies (§7)

  private async evaluateVerify(
    v: Verify,
    act: Action,
    result: Record<string, unknown>,
  ): Promise<{ pass: true; event: PartialEvent } | { pass: false; verdict: Verdict; event: PartialEvent }> {
    const tool = act.name;
    const args = act.args;
    const state = this.agent.state;
    const fallback: Verdict = v.kind === "output" || v.kind === "judge" ? "deny" : "safe_state";
    const verdict: Verdict = v.otherwise === "deny" || v.otherwise === "safe_state" ? v.otherwise : fallback;

    if (v.kind === "effect") {
      const obs = await this.runObservation(v.observe);
      if (!obs.ok) {
        return {
          pass: false,
          verdict,
          event: {
            stage: "verify",
            verdict,
            reason: "verify_effect_failed",
            tool,
            args,
            failure: { kind: "observation_failed" },
          },
        };
      }
      const snap: Snapshot = { action: act, state, result, observation: obs.observation };
      if (!evalPredicate(v.require, snap)) {
        return {
          pass: false,
          verdict,
          event: { stage: "verify", verdict, reason: "verify_effect_failed", tool, args, observation: obs.observation },
        };
      }
      return { pass: true, event: { stage: "verify", verdict: "allow", tool, observation: obs.observation } };
    }

    if (v.kind === "output") {
      return this.evaluateOutputVerify(v, act, result, verdict);
    }

    if (v.kind === "judge") {
      if (!this.allowJudge || !this.judge) {
        return {
          pass: false,
          verdict,
          event: {
            stage: "verify",
            verdict,
            reason: "verify_judge_invalid",
            tool,
            args,
            failure: { kind: "judge", code: "unavailable" },
          },
        };
      }
      const raw = await this.judge(v.rubric, { action: act, result, state });
      const judgment = this.readJudgment(raw);
      if (!judgment.ok) {
        return {
          pass: false,
          verdict,
          event: {
            stage: "verify",
            verdict,
            reason: "verify_judge_invalid",
            tool,
            args,
            failure: { kind: "judge", code: "invalid" },
            ...(judgment.raw !== undefined ? { error: excerpt(judgment.raw, EXCERPT_CHARS) } : {}),
          },
        };
      }
      const snap: Snapshot = { action: act, state, result, judgment: judgment.value };
      if (!evalPredicate(v.require, snap)) {
        return {
          pass: false,
          verdict,
          event: { stage: "verify", verdict, reason: "verify_judge_failed", tool, args, result: judgment.value },
        };
      }
      return { pass: true, event: { stage: "verify", verdict: "allow", tool, result: judgment.value } };
    }

    const reason: ReasonCode = v.kind === "evidence" ? "verify_evidence_failed" : "verify_absence_failed";
    const snap: Snapshot = { action: act, state, result };
    if (!evalPredicate(v.require, snap)) {
      return { pass: false, verdict, event: { stage: "verify", verdict, reason, tool, args, result } };
    }
    return { pass: true, event: { stage: "verify", verdict: "allow", tool, result } };
  }

  private readJudgment(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; raw?: string } {
    if (isPlainObject(raw) && raw.invalid === true) {
      return { ok: false, raw: typeof raw.raw === "string" ? raw.raw : undefined };
    }
    if (!isPlainObject(raw)) return { ok: false };
    const score = raw.score;
    const reason = raw.reason;
    if (typeof reason !== "string" || !toCanonical(score).ok || typeof score !== "number") return { ok: false };
    return { ok: true, value: { score: score === 0 ? 0 : score, reason: excerpt(reason, EXCERPT_CHARS) } };
  }

  private messageObservation(content: string): Record<string, unknown> {
    const snap = buildMessageSnapshot(content);
    return { message: { ...snap, content: excerpt(snap.content, this.maxObservationChars()) } };
  }

  private evaluateOutputVerify(
    v: VerifyOutput,
    act: Action,
    result: Record<string, unknown>,
    verdict: Verdict,
  ): { pass: true; event: PartialEvent } | { pass: false; verdict: Verdict; event: PartialEvent } {
    const content =
      typeof act.args.message === "string"
        ? act.args.message
        : typeof result.message === "string"
          ? result.message
          : "";
    const message = buildMessageSnapshot(content);
    const snap: Snapshot = { action: act, state: this.agent.state, result, message };
    const observation = this.messageObservation(content);
    if (!evalPredicate(v.require, snap)) {
      return {
        pass: false,
        verdict,
        event: {
          stage: "verify",
          verdict,
          reason: "verify_output_failed",
          tool: act.name,
          args: act.args,
          result,
          observation,
        },
      };
    }
    return { pass: true, event: { stage: "verify", verdict: "allow", tool: act.name, result, observation } };
  }

  /** §8.6 agent-level output verifies on a stop message. Returns the failing verdict, if any. */
  private async runAgentOutputVerifies(content: string): Promise<Verdict | null> {
    const message = buildMessageSnapshot(content);
    const snap: Snapshot = { state: this.agent.state, message };
    const observation = this.messageObservation(content);
    for (const v of this.agent.counterbalance?.output_verifies ?? []) {
      if (v.kind !== "output") continue;
      if (evalPredicate(v.require, snap)) {
        this.emit({ stage: "verify", verdict: "allow", observation });
        continue;
      }
      const verdict: Verdict = v.otherwise === "safe_state" ? "safe_state" : "deny";
      this.emit({ stage: "verify", verdict, reason: "verify_output_failed", observation });
      return verdict;
    }
    return null;
  }

  /** Governed observation for effect verifies (§7). */
  private async runObservation(
    observerId: string,
  ): Promise<{ ok: true; observation: Record<string, unknown> } | { ok: false }> {
    const observer = this.toolById(observerId);
    if (!observer || observer.read_only !== true || (observer.channel ?? "world") !== "world") {
      this.emit({ stage: "validate", verdict: "deny", reason: "capability_missing", tool: observerId });
      return { ok: false };
    }
    const inCheck = validateAgainstSchema(observer.input, {});
    if (!inCheck.ok) {
      this.emit({
        stage: "validate",
        verdict: "deny",
        reason: inCheck.compileError ? "schema_invalid" : "input_schema_invalid",
        tool: observerId,
      });
      return { ok: false };
    }
    if (!this.isPermitted(observerId)) {
      this.emit({ stage: "authorize", verdict: "deny", reason: "capability_missing", tool: observerId });
      return { ok: false };
    }
    if (this.toolCalls >= this.maxToolCalls()) {
      this.emit({ stage: "authorize", verdict: "deny", reason: "limit_exceeded", tool: observerId });
      return { ok: false };
    }
    this.toolCalls += 1;
    const invoked = await this.invoke(observerId, {});
    if (!invoked.ok) {
      this.emit({
        stage: "observe",
        verdict: "deny",
        reason: "tool_execution_failed",
        tool: observerId,
        failure: invoked.failure,
        ...(invoked.error !== undefined ? { error: invoked.error } : {}),
      });
      return { ok: false };
    }
    const env = readEnvelope(invoked.raw);
    if (!env) {
      this.emit({
        stage: "observe",
        verdict: "deny",
        reason: "output_schema_invalid",
        tool: observerId,
        failure: { kind: "malformed_envelope" },
      });
      return { ok: false };
    }
    const canon = toCanonical(env.output, "$.observation");
    if (!canon.ok) {
      this.emit({
        stage: "observe",
        verdict: "deny",
        reason: "output_schema_invalid",
        tool: observerId,
        failure: buildNonCanonicalFailure(canon.path),
      });
      return { ok: false };
    }
    const observation = this.sanitize(canon.value) as Record<string, unknown>;
    if (!validateAgainstSchema(observer.output, observation).ok) {
      this.emit({ stage: "observe", verdict: "deny", reason: "output_schema_invalid", tool: observerId });
      return { ok: false };
    }
    this.emit({ stage: "observe", verdict: "allow", tool: observerId, args: {}, result: observation });
    return { ok: true, observation };
  }

  // ---------------------------------------------------------------- contract tools (§12)

  private applyContractEffect(act: Action, effect: ContractEffect): void {
    if (effect.kind === "patch") {
      const before = harnessIrHash(this.agent, this.initialState);
      applyHarnessPatch(this.agent, effect.patch);
      const after = harnessIrHash(this.agent, this.initialState);
      this.emit({
        stage: "rebalance",
        verdict: "allow",
        reason: "harness_patch_applied",
        tool: act.name,
        args: act.args,
        harness_hash_before: before,
        harness_hash_after: after,
        observation: { ops: effect.patch.ops.length, ...(effect.reflect ? { disposition: "propose" } : {}) },
      });
      return;
    }
    this.emit({
      stage: "record",
      verdict: "allow",
      reason: "harness_patch_declined",
      tool: act.name,
      args: act.args,
      observation: {
        reason: effect.reason,
        ...(effect.reflect ? { disposition: "decline" } : {}),
        ...(effect.note !== undefined ? { note: effect.note } : {}),
      },
    });
  }

  // ---------------------------------------------------------------- spawn (§10)

  private buildChildAgent(packet: SpawnPacket): AgentIR {
    const parent = this.agent;
    const remainingSteps = Math.max(0, this.maxSteps() - this.steps);
    const remainingCalls = Math.max(0, this.maxToolCalls() - this.toolCalls);
    const childIds = new Set(packet.tools);
    const fs = parent.permissions?.filesystem;
    const filesystem: { write_scopes?: string[]; read_scopes?: string[] } = {};
    const write = packet.write_scopes ?? fs?.write_scopes;
    const read = packet.read_scopes ?? fs?.read_scopes;
    if (write) filesystem.write_scopes = write;
    if (read) filesystem.read_scopes = read;
    let counterbalance = parent.counterbalance ? structuredClone(parent.counterbalance) : undefined;
    if (counterbalance) {
      delete counterbalance.intervention_budget;
      delete counterbalance.triggers;
      if (Object.keys(counterbalance).length === 0) counterbalance = undefined;
    }
    const child: AgentIR = {
      spec: parent.spec,
      name: `${parent.name}/child`,
      state: structuredClone(parent.state),
      tools: structuredClone(parent.tools.filter((t) => childIds.has(t.id))),
      limits: {
        max_steps: packet.max_steps ?? remainingSteps,
        max_tool_calls: packet.max_tool_calls ?? remainingCalls,
        ...(parent.limits?.max_observation_chars !== undefined
          ? { max_observation_chars: parent.limits.max_observation_chars }
          : {}),
      },
      permissions: {
        tools: [...packet.tools],
        ...(Object.keys(filesystem).length ? { filesystem } : {}),
        ...(parent.permissions?.secrets ? { secrets: structuredClone(parent.permissions.secrets) } : {}),
        ...(parent.permissions?.protected_paths ? { protected_paths: [...parent.permissions.protected_paths] } : {}),
      },
      spawn: { allow: parent.spawn?.allow_nested === true, allow_nested: false, tighten_only: true },
    };
    if (parent.gates) child.gates = structuredClone(parent.gates);
    if (parent.fallback_state) child.fallback_state = structuredClone(parent.fallback_state);
    if (parent.recovery) child.recovery = structuredClone(parent.recovery);
    if (counterbalance) child.counterbalance = counterbalance;
    return child;
  }

  private async runChild(packet: SpawnPacket, spawnId: string): Promise<void> {
    const childAgent = this.buildChildAgent(packet);
    const proposals = (packet.proposals ?? []).map(toProposal);
    let pi = 0;
    const handlers: Record<string, ToolHandler> = {};
    for (const id of packet.tools) {
      const h = this.tools[id];
      if (typeof h === "function") handlers[id] = h;
    }
    const child = new FaustRuntime({
      agent: childAgent,
      propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
      tools: handlers,
      depth: this.depth + 1,
      spawnId,
      allowJudge: false,
      ...(this.transcript ? { transcript: this.transcript } : {}),
    });
    await child.runLoop((childAgent.limits?.max_steps ?? 0) + 1);
    for (const cev of child.events) {
      this.seq += 1;
      this.events.push({ ...cev, seq: this.seq, ts_logical: this.seq });
    }
    // Child budgets are charged to the parent (D6).
    this.steps += child.steps;
    this.toolCalls += child.toolCalls;
    this.emit({
      stage: "record",
      verdict: "allow",
      reason: "spawn_returned",
      tool: SPAWN_TOOL,
      result: { events: child.events.length, steps: child.steps, tool_calls: child.toolCalls },
    });
  }

  // ---------------------------------------------------------------- safe flow (§11)

  private applyFallbackState(): void {
    const fb = fallbackStateOf(this.agent);
    if (fb) this.agent.state = { ...this.agent.state, ...fb };
    this.emit({ stage: "record", verdict: "safe_state", reason: "safe_state_entered" });
  }

  private async safeFlow(trigger: ReasonCode): Promise<void> {
    const recovery = this.agent.recovery;
    if (recovery && !this.recovering && (recovery.on === undefined || recovery.on === trigger)) {
      this.recovering = true;
      let outcome: Outcome;
      try {
        outcome = await this.processAction(
          { name: recovery.execute.tool, args: (recovery.execute.args ?? {}) as Record<string, unknown> },
          "recovery",
        );
      } finally {
        this.recovering = false;
      }
      if (outcome === "success") {
        this.emit({ stage: "record", verdict: "allow", reason: "recovery_succeeded" });
      } else {
        this.emit({ stage: "record", verdict: "deny", reason: "terminal_failure" });
      }
    }
    this.applyFallbackState();
  }

  // ---------------------------------------------------------------- introspection

  /** Successful (executed + verified) tool ids, sorted. */
  successfulTools(): string[] {
    return sortCodePoints(this.succeeded);
  }

  /** Steps and tool calls used so far (children included). */
  usage(): { steps: number; tool_calls: number } {
    return { steps: this.steps, tool_calls: this.toolCalls };
  }
}

type ContractEffect =
  | { kind: "patch"; patch: HarnessPatch; reflect: boolean }
  | { kind: "decline"; reason: string; note?: string; reflect?: boolean };

export function eventsToJsonl(events: Event[]): string {
  return events.map((e) => canonicalJson(e)).join("\n") + "\n";
}
