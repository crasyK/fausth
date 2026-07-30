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

/**
 * Multi-turn propose that feeds tool results back into the chat transcript.
 * When tools are offered, empty stop/invalid responses are retried once.
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
      messages.push({ role: "assistant", content: proposal.message ?? "" });
      return;
    }
    if (proposal.type === "invalid") {
      messages.push({
        role: "assistant",
        content: proposal.raw ?? proposal.reason,
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
      messages.push({ role: "user", content: TOOL_NUDGE });
      proposal = await proposeOnce();
      eventMark = runtime.events.length;
      if (proposal.type === "stop" || proposal.type === "invalid") {
        const raw =
          proposal.type === "stop"
            ? (proposal.message ?? "")
            : (proposal.raw ?? proposal.reason);
        return {
          type: "invalid",
          reason: "empty_proposal",
          raw: String(raw).slice(0, 500),
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
      });
      pending = { tool_call_id, transport_name };
      return {
        type: "tool",
        name: proposal.name,
        args: proposal.args,
        tool_call_id,
        transport_name,
      };
    }

    if (proposal.type === "stop") {
      messages.push({ role: "assistant", content: proposal.message ?? "" });
    }
    return proposal;
  };
}
