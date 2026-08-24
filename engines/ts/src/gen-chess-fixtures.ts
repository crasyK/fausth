#!/usr/bin/env node
/**
 * Generate chess conformance fixtures (Track A golden logs).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FaustRuntime, eventsToJsonl } from "./runtime.js";
import { agentYamlToIr, loadYamlFile, toCanonicalIrJson } from "./load.js";
import {
  agentUsesChess,
  chessWorldFromAgent,
  createChessTools,
  observeOutput,
  positionHash,
  START_FEN,
} from "./adapters/chess.js";
import { Chess } from "chess.js";
import type { AgentIR, ModelProposal } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesRoot = join(root, "conformance/fixtures");

async function writeFixture(
  name: string,
  agent: AgentIR,
  proposals: ModelProposal[],
  worldFactory?: (agent: AgentIR) => ReturnType<typeof chessWorldFromAgent>,
) {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  const world = worldFactory ? worldFactory(agent) : chessWorldFromAgent(agent);
  writeFileSync(join(dir, "agent.json"), toCanonicalIrJson(agent));
  writeFileSync(
    join(dir, "model.jsonl"),
    proposals.map((p) => JSON.stringify(p)).join("\n") + "\n",
  );
  let pi = 0;
  const runtime = new FaustRuntime({
    agent,
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools: createChessTools(world),
    allowJudge: false,
  });
  await runtime.runLoop();
  writeFileSync(join(dir, "expected.jsonl"), eventsToJsonl(runtime.events));
  console.log("wrote", name, runtime.events.length, "events");
}

async function main() {
  const gated = agentYamlToIr(
    loadYamlFile(join(root, "case-studies/chess/harnesses/legality-gated/agent.yml")),
  );
  const permissive = agentYamlToIr(
    loadYamlFile(join(root, "case-studies/chess/harnesses/permissive-control/agent.yml")),
  );

  // Legal move after observe
  const obs = observeOutput(chessWorldFromAgent(gated));
  await writeFixture(
    "chess-legal-move-ok",
    gated,
    [
      { type: "tool", name: "board.observe", args: {} },
      { type: "tool", name: "board.move", args: { move: "e2e4", position_hash: obs.position_hash } },
      { type: "stop" },
    ],
  );

  // Illegal move denied by verify
  await writeFixture(
    "chess-illegal-move-denied",
    gated,
    [
      { type: "tool", name: "board.observe", args: {} },
      { type: "tool", name: "board.move", args: { move: "e2e9", position_hash: obs.position_hash } },
      { type: "stop" },
    ],
  );

  // Stale position_hash rejected
  await writeFixture(
    "chess-stale-state-rejected",
    gated,
    [
      { type: "tool", name: "board.observe", args: {} },
      { type: "tool", name: "board.move", args: { move: "e2e4", position_hash: "deadbeefdeadbeef" } },
      { type: "stop" },
    ],
  );

  // Claim without observe denied by gate
  await writeFixture("chess-claim-without-evidence-denied", gated, [
    { type: "tool", name: "game.claim", args: { kind: "checkmate" } },
    { type: "stop" },
  ]);

  // Move without observe denied by sequence (gated only)
  await writeFixture("chess-move-without-observe-denied", gated, [
    { type: "tool", name: "board.move", args: { move: "e2e4" } },
    { type: "stop" },
  ]);

  // Deterministic replay: two legal moves
  const chess1 = new Chess(START_FEN);
  chess1.move("e4");
  const hashAfterE4 = positionHash(chess1.fen());
  await writeFixture(
    "chess-replay-determinism",
    gated,
    [
      { type: "tool", name: "board.observe", args: {} },
      { type: "tool", name: "board.move", args: { move: "e2e4", position_hash: obs.position_hash } },
      { type: "tool", name: "board.observe", args: {} },
      { type: "tool", name: "board.move", args: { move: "e7e5", position_hash: hashAfterE4 } },
      { type: "stop" },
    ],
  );

  // Terminal claim after fool's mate position
  const mateFen = (() => {
    const c = new Chess();
    c.move("f3");
    c.move("e5");
    c.move("g4");
    c.move("Qh4#");
    return c.fen();
  })();
  const mateAgent: AgentIR = {
    ...gated,
    state: { ...gated.state, fen: mateFen, game_over: 1 },
  };
  await writeFixture(
    "chess-terminal-claim-verified",
    mateAgent,
    [
      { type: "tool", name: "board.observe", args: {} },
      { type: "tool", name: "game.claim", args: { kind: "checkmate" } },
      { type: "stop" },
    ],
    () => chessWorldFromAgent(mateAgent),
  );

  // Permissive allows move without observe (no sequence) — illegal still returns but not verify-denied
  await writeFixture("chess-permissive-illegal-allowed", permissive, [
    { type: "tool", name: "board.move", args: { move: "e2e9" } },
    { type: "stop" },
  ]);

  console.log("chess fixtures done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
