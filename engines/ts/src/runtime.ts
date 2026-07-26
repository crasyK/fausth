import { canonicalJson, stateHash } from "./canonical.js";
import { evalPredicate } from "./predicates.js";
import type {
  AgentIR,
  Event,
  Gate,
  ModelProposal,
  ReasonCode,
  Snapshot,
  ToolDef,
  Verdict,
  Verify,
} from "./types.js";

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { state: Record<string, unknown> },
) => Promise<Record<string, unknown>> | Record<string, unknown>;

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
  /** Recorded tool results queue for fixtures (consume in order). */
  recordedToolResults?: Record<string, unknown>[];
};

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
  private recordedToolResults: Record<string, unknown>[];
  private recordedIdx = 0;

  constructor(opts: RuntimeOptions) {
    this.agent = structuredClone(opts.agent);
    this.propose = opts.propose;
    this.tools = opts.tools;
    this.judge = opts.judge;
    this.allowJudge = opts.allowJudge ?? false;
    this.recordedToolResults = opts.recordedToolResults ?? [];
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
    this.events.push(ev);
    return ev;
  }

  private toolById(id: string): ToolDef | undefined {
    return this.agent.tools.find((t) => t.id === id);
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

  private async runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.recordedToolResults.length > this.recordedIdx) {
      const r = this.recordedToolResults[this.recordedIdx++]!;
      return r as Record<string, unknown>;
    }
    const handler = this.tools[name];
    if (!handler) {
      throw new Error(`No native handler for ${name}`);
    }
    return await handler(args, { state: this.agent.state });
  }

  private applySafeState(): void {
    if (this.agent.safe_state) {
      this.agent.state = { ...this.agent.state, ...this.agent.safe_state };
    }
    this.emit({
      stage: "record",
      verdict: "safe_state",
      reason: "safe_state_entered",
    });
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
      const observation = await this.runTool(v.observe, {});
      const snapshot: Snapshot = {
        action,
        state: this.agent.state,
        result,
        observation,
      };
      if (!evalPredicate(v.require, snapshot)) {
        const verdict = v.otherwise ?? "safe_state";
        this.emit({
          stage: "verify",
          verdict,
          reason: "verify_effect_failed",
          tool: action.name,
          args: action.args,
          observation,
        });
        if (verdict === "safe_state") this.applySafeState();
        return false;
      }
      this.emit({
        stage: "verify",
        verdict: "allow",
        tool: action.name,
        observation,
      });
      return true;
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
      if (verdict === "safe_state") this.applySafeState();
      return false;
    }
    this.emit({ stage: "verify", verdict: "allow", tool: action.name, result });
    return true;
  }

  /** Run until stop proposal or deny/limit. */
  async runLoop(maxIterations = 32): Promise<Event[]> {
    for (let i = 0; i < maxIterations; i++) {
      if (!this.checkLimits()) break;
      this.steps += 1;

      const proposal = await this.propose();
      if (!proposal || proposal.type === "stop") {
        this.emit({
          stage: "propose",
          verdict: "allow",
        });
        break;
      }

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
        break;
      }

      // permissions tool allowlist
      const allowed = this.agent.permissions?.tools;
      if (allowed && !allowed.includes(action.name) && action.name !== "agent.spawn") {
        this.emit({
          stage: "validate",
          verdict: "deny",
          reason: "capability_missing",
          tool: action.name,
          args: action.args,
        });
        break;
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
        if (gated.verdict === "safe_state") this.applySafeState();
        break;
      }

      // tighten-only: child tools must be ⊆ parent permissions
      if (action.name === "agent.spawn") {
        const childTools = (action.args.tools as string[]) ?? [];
        const parentTools = this.agent.permissions?.tools ?? this.agent.tools.map((t) => t.id);
        const escalate = childTools.some((t) => !parentTools.includes(t));
        if (escalate) {
          this.emit({
            stage: "authorize",
            verdict: "deny",
            reason: "gate_denied",
            tool: action.name,
            args: action.args,
          });
          break;
        }
      }

      this.emit({ stage: "authorize", verdict: "allow", tool: action.name, args: action.args });

      this.toolCalls += 1;

      let result: Record<string, unknown>;
      try {
        result = await this.runTool(action.name, action.args);
      } catch (e) {
        this.emit({
          stage: "execute",
          verdict: "deny",
          reason: "schema_invalid",
          tool: action.name,
          args: action.args,
          error: e instanceof Error ? e.message : String(e),
        });
        break;
      }

      // Apply state patches from result if present
      if (result._state_patch && typeof result._state_patch === "object") {
        this.agent.state = {
          ...this.agent.state,
          ...(result._state_patch as Record<string, unknown>),
        };
        const { _state_patch: _, ...rest } = result;
        result = rest;
      }

      this.emit({
        stage: "execute",
        verdict: "allow",
        tool: action.name,
        args: action.args,
        result,
      });

      const verified = await this.runVerifies(tool, action, result);
      if (!verified) break;
    }
    return this.events;
  }
}

export function eventsToJsonl(events: Event[]): string {
  return events.map((e) => canonicalJson(e)).join("\n") + "\n";
}
