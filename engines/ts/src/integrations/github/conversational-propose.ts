import type { FaustRuntime } from "../../runtime.js";
import type { Event } from "../../types.js";
import type { ChatMessage, ModelPort, ModelProposal, ModelToolDef } from "../../model/port.js";

/**
 * Multi-turn propose that feeds tool results back into the chat transcript.
 * Required for advisory review (read packet → read file → finding.submit).
 */
export function createConversationalPropose(opts: {
  adapter: ModelPort;
  tools: ModelToolDef[];
  system: string;
  user: string;
  getRuntime: () => FaustRuntime;
}): () => Promise<ModelProposal> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  let pending: { tool_call_id: string; transport_name: string } | null = null;
  let eventMark = 0;

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
      return JSON.stringify({
        error: denied.reason ?? denied.error ?? "denied",
        verdict: denied.verdict,
        orientation: orient?.observation ?? null,
      });
    }
    return JSON.stringify({ error: "no_tool_result", orientation: orient?.observation ?? null });
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

    const proposal = await opts.adapter.propose({
      messages,
      tools: opts.tools,
    });

    eventMark = runtime.events.length;

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
