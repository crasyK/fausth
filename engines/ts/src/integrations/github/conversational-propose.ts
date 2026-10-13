import type { FaustRuntime } from "../../runtime.js";
import { renderDenyFailureProse } from "../../deny-failure.js";
import type { Event } from "../../types.js";
import type {
  ChatMessage,
  ModelPort,
  ModelProposal,
  ModelToolChoice,
  ModelToolDef,
} from "../../model/port.js";

const TOOL_NUDGE =
  "You must call one of the provided tools. Do not answer in plain text.";
const SINGLE_TOOL_NUDGE =
  "Call exactly one tool per turn. Parallel tool calls are not executed; repeat only the single most important call.";

/** Code-point-safe truncation (D2). */
function truncateCodePoints(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n).join("") : s;
}

function nudgeFor(proposal: ModelProposal): string {
  return proposal.type === "invalid" && proposal.reason === "multiple_tool_calls"
    ? SINGLE_TOOL_NUDGE
    : TOOL_NUDGE;
}

/** Host-side transcript metadata for an assistant turn (scoped re-send of provider fields). */
function provenanceOf(proposal: ModelProposal): Pick<ChatMessage, "model" | "provider_fields"> {
  return {
    ...(proposal.model ? { model: proposal.model } : {}),
    ...(proposal.provider_fields ? { provider_fields: proposal.provider_fields } : {}),
  };
}

/**
 * Multi-turn propose that feeds tool results back into the chat transcript.
 * When tools are offered, empty stop/invalid responses are retried once.
 *
 * Transcript invariants: every assistant `tool_calls` entry is answered by exactly one
 * `tool` message before the next request (only single-call turns are recorded as
 * tool_calls; multi-call turns are `invalid` and recorded as plain assistant text).
 * Infra failures (`ModelInfraError`) propagate to the caller unchanged.
 */
export function createConversationalPropose(opts: {
  adapter: ModelPort;
  tools: ModelToolDef[];
  system: string;
  user: string;
  getRuntime: () => FaustRuntime;
  /** Default "required" when tools.length > 0; probes may pass "auto". */
  tool_choice?: ModelToolChoice;
}): () => Promise<ModelProposal> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  let pending: { tool_call_id: string; transport_name: string } | null = null;
  let eventMark = 0;
  const toolChoice: ModelToolChoice =
    opts.tool_choice ?? (opts.tools.length > 0 ? "required" : "auto");

  function toolResultContent(events: Event[]): string {
    const orient = [...events].reverse().find((e) => e.stage === "orient");
    const exec = [...events].reverse().find((e) => e.stage === "execute");
    if (exec?.result !== undefined) {
      const verifyFail = events.find(
        (e) => e.stage === "verify" && e.verdict && e.verdict !== "allow",
      );
      if (verifyFail) {
        return JSON.stringify({
          ...(exec.result as object),
          verify_verdict: verifyFail.verdict,
          verify_reason: verifyFail.reason ?? null,
          orientation: orient?.observation ?? null,
        });
      }
      return JSON.stringify({
        ...(exec.result as object),
        orientation: orient?.observation ?? null,
      });
    }
    const denied = [...events]
      .reverse()
      .find(
        (e) =>
          (e.stage === "validate" || e.stage === "authorize" || e.stage === "execute") &&
          e.verdict &&
          e.verdict !== "allow",
      );
    if (denied) {
      const payload: Record<string, unknown> = {
        error: denied.reason ?? denied.error ?? "denied",
        verdict: denied.verdict,
        orientation: orient?.observation ?? null,
      };
      if (denied.failure) {
        payload.failure = denied.failure;
        const prose = renderDenyFailureProse(denied.failure);
        if (prose) payload.hint = prose;
      } else if (denied.error && denied.error !== denied.reason) {
        payload.hint = denied.error;
      }
      return JSON.stringify(payload);
    }
    return JSON.stringify({ error: "no_tool_result", orientation: orient?.observation ?? null });
  }

  async function proposeOnce(): Promise<ModelProposal> {
    return opts.adapter.propose({
      messages,
      tools: opts.tools,
      tool_choice: opts.tools.length > 0 ? toolChoice : undefined,
    });
  }

  function recordAssistant(proposal: ModelProposal): void {
    if (proposal.type === "stop") {
      messages.push({ role: "assistant", content: proposal.message ?? "", ...provenanceOf(proposal) });
      return;
    }
    if (proposal.type === "invalid") {
      messages.push({
        role: "assistant",
        content: proposal.raw ?? proposal.reason,
        ...provenanceOf(proposal),
      });
    }
  }

  return async () => {
    const runtime = opts.getRuntime();
    if (pending) {
      const events = runtime.events.slice(eventMark);
      messages.push({
        role: "tool",
        tool_call_id: pending.tool_call_id,
        content: toolResultContent(events),
      });
      pending = null;
    }

    let proposal = await proposeOnce();
    eventMark = runtime.events.length;

    if (
      opts.tools.length > 0 &&
      (proposal.type === "stop" || proposal.type === "invalid")
    ) {
      recordAssistant(proposal);
      messages.push({ role: "user", content: nudgeFor(proposal) });
      proposal = await proposeOnce();
      eventMark = runtime.events.length;
      if (proposal.type === "stop") {
        return {
          type: "invalid",
          reason: "empty_proposal",
          raw: truncateCodePoints(String(proposal.message ?? ""), 500),
          ...provenanceOf(proposal),
        };
      }
      if (proposal.type === "invalid") {
        // Keep the model-protocol reason (e.g. multiple_tool_calls) — honest logs.
        return {
          ...proposal,
          raw: truncateCodePoints(String(proposal.raw ?? proposal.reason), 500),
        };
      }
    }

    if (proposal.type === "tool") {
      const tool_call_id = proposal.tool_call_id ?? `call_${messages.length}`;
      const transport_name = proposal.transport_name ?? proposal.name;
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: tool_call_id,
            type: "function",
            function: {
              name: transport_name,
              arguments: JSON.stringify(proposal.args ?? {}),
            },
          },
        ],
        ...provenanceOf(proposal),
      });
      pending = { tool_call_id, transport_name };
      return {
        type: "tool",
        name: proposal.name,
        args: proposal.args,
        tool_call_id,
        transport_name,
        ...(proposal.model ? { model: proposal.model } : {}),
      };
    }

    if (proposal.type === "stop") {
      messages.push({ role: "assistant", content: proposal.message ?? "", ...provenanceOf(proposal) });
    }
    return proposal;
  };
}
