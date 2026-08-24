import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import {
  START_FEN,
  chessWorldFromAgent,
  createChessTools,
  legalMovesUci,
  observeOutput,
  positionHash,
  replayHashFromMoves,
  terminalStatus,
} from "./chess.js";
import type { AgentIR } from "../types.js";

const baseAgent: AgentIR = {
  spec: "counterbalance-contract/v0.1",
  name: "chess-test",
  state: { fen: START_FEN },
  tools: [
    { id: "board.observe", input: { type: "object" }, output: { type: "object" } },
    { id: "board.move", input: { type: "object" }, output: { type: "object" } },
    { id: "game.claim", input: { type: "object" }, output: { type: "object" } },
  ],
  permissions: { tools: ["board.observe", "board.move", "game.claim"] },
};

describe("chess adapter", () => {
  it("starts with 20 legal moves from start position", () => {
    const world = chessWorldFromAgent(baseAgent);
    const legal = legalMovesUci(world.chess);
    assert.equal(legal.length, 20);
    assert.ok(legal.includes("e2e4"));
  });

  it("applies legal move and updates fen", async () => {
    const world = chessWorldFromAgent(baseAgent);
    const tools = createChessTools(world);
    const obs = (await tools["board.observe"]!({}, { state: {} })) as { output: Record<string, unknown> };
    const hash = String(obs.output.position_hash);
    const mv = (await tools["board.move"]!(
      { move: "e2e4", position_hash: hash },
      { state: { observed: 1 } },
    )) as { output: Record<string, unknown> };
    assert.equal(mv.output.ok, 1);
    assert.equal(mv.output.illegal, 0);
    assert.match(String(mv.output.fen), /4P3/);
  });

  it("rejects illegal move without mutating board", async () => {
    const world = chessWorldFromAgent(baseAgent);
    const tools = createChessTools(world);
    const before = world.chess.fen();
    const mv = (await tools["board.move"]!(
      { move: "e2e9", position_hash: positionHash(before) },
      { state: {} },
    )) as { output: Record<string, unknown> };
    assert.equal(mv.output.ok, 0);
    assert.equal(mv.output.illegal, 1);
    assert.equal(world.chess.fen(), before);
  });

  it("rejects stale position_hash", async () => {
    const world = chessWorldFromAgent(baseAgent);
    const tools = createChessTools(world);
    const mv = (await tools["board.move"]!(
      { move: "e2e4", position_hash: "stalehash0000000" },
      { state: {} },
    )) as { output: Record<string, unknown> };
    assert.equal(mv.output.stale, 1);
    assert.equal(mv.output.ok, 0);
  });

  it("replay hash is deterministic", () => {
    const h1 = replayHashFromMoves(["e2e4", "e7e5"]);
    const h2 = replayHashFromMoves(["e2e4", "e7e5"]);
    assert.equal(h1, h2);
    const c = new Chess();
    c.move("e4");
    c.move("e5");
    assert.equal(h1, positionHash(c.fen()));
  });

  it("detects fool's mate terminal", () => {
    const c = new Chess();
    c.move("f3");
    c.move("e5");
    c.move("g4");
    c.move("Qh4#");
    const term = terminalStatus(c);
    assert.equal(term.game_over, 1);
    assert.equal(term.result, "checkmate");
  });

  it("claim requires observe evidence", async () => {
    const c = new Chess();
    c.move("f3");
    c.move("e5");
    c.move("g4");
    c.move("Qh4#");
    const agent = { ...baseAgent, state: { fen: c.fen() } };
    const world = chessWorldFromAgent(agent);
    const tools = createChessTools(world);
    const denied = (await tools["game.claim"]!({ kind: "checkmate" }, { state: { observed: 0 } })) as {
      output: Record<string, unknown>;
    };
    assert.equal(denied.output.ok, 0);
    await tools["board.observe"]!({}, { state: {} });
    const ok = (await tools["game.claim"]!({ kind: "checkmate" }, { state: { observed: 1 } })) as {
      output: Record<string, unknown>;
    };
    assert.equal(ok.output.ok, 1);
  });
});
