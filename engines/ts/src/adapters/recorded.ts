import type { ModelProposal } from "../types.js";

export interface LLMPort {
  propose(input: {
    messages: { role: string; content: string }[];
    tools: { id: string; description?: string }[];
  }): Promise<ModelProposal>;
}

export class RecordedAdapter implements LLMPort {
  private idx = 0;
  constructor(private proposals: ModelProposal[]) {}

  async propose(): Promise<ModelProposal> {
    if (this.idx >= this.proposals.length) {
      return { type: "stop" };
    }
    return this.proposals[this.idx++]!;
  }
}

export function parseRecordedModelLine(line: unknown): ModelProposal {
  const o = line as Record<string, unknown>;
  if (o.type === "stop") {
    return { type: "stop", message: o.message as string | undefined };
  }
  if (o.type === "tool" || o.name) {
    return {
      type: "tool",
      name: String(o.name ?? o.tool),
      args: (o.args as Record<string, unknown>) ?? {},
    };
  }
  throw new Error(`Invalid model.jsonl entry: ${JSON.stringify(line)}`);
}
