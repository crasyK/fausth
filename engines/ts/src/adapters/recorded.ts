import type { ModelProposal } from "../types.js";
import { parseRecordedProposal } from "../load.js";

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

/**
 * One recorded `model.jsonl` line → runtime proposal. Same parser as the replay host
 * (`load.ts` parseRecordedProposal): `tool`, `stop` and `invalid` lines (spec-v0.3 §5.5 —
 * an invalid line keeps its protocol reason and is never turned into a stop).
 */
export function parseRecordedModelLine(line: unknown): ModelProposal {
  return parseRecordedProposal(line);
}
