import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FaustRuntime, eventsToJsonl } from "../runtime.js";
import { createSimulationCodingAdapter } from "./simulation.js";
import type { AgentIR, ModelProposal } from "../types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("SimulationWorldAdapter", () => {
  it("replays cb-write-before-plan-denied without real FS", async () => {
    const agent = JSON.parse(
      readFileSync(join(root, "conformance/fixtures/cb-write-before-plan-denied/agent.json"), "utf8"),
    ) as AgentIR;
    const proposals = [
      JSON.parse(
        readFileSync(join(root, "conformance/fixtures/cb-write-before-plan-denied/model.jsonl"), "utf8")
          .trim()
          .split(/\n/)[0]!,
      ),
    ] as ModelProposal[];
    const { tools } = createSimulationCodingAdapter();
    let pi = 0;
    const rt = new FaustRuntime({
      agent,
      propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
      tools,
    });
    await rt.runLoop();
    const expected = readFileSync(
      join(root, "conformance/fixtures/cb-write-before-plan-denied/expected.jsonl"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    assert.equal(eventsToJsonl(rt.events), expected);
  });
});
