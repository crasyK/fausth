import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chessTools, moveProblem, renderBoard, turnBrief } from "./chess-tools.js";

// The chess fixture's tool results were recorded with python-chess (the Python host's tools). The
// browser tools must give the same results for the same game.
const dir = new URL("../../../conformance/fixtures/chess/", import.meta.url);
async function hashOf(tools: ReturnType<typeof chessTools>): Promise<string> {
  const a = await tools.board_observe();
  return a.ok ? (a.result as { position_hash: string }).position_hash : "";
}

const recorded = readFileSync(new URL("tools.jsonl", dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("chess.js tools reproduce the python-chess results of the chess fixture", async () => {
  const tools = chessTools();
  const results: unknown[] = [];
  for (const line of recorded) {
    const { id, ...answer } = line;
    let got;
    if (id === "board_observe") got = await tools.board_observe();
    else if (id === "board_legal_moves") got = await tools.board_legal_moves();
    else {
      got = await tools.board_move({ move: answer.result.played, position_hash: await hashOf(tools) });
      if (answer.result.played === "e2e4") tools.game.move("e5"); // Black's reply, as the fixture's host applied it
    }
    results.push(got);
    assert.deepEqual(got, answer, `${id}`);
  }
  assert.equal(results.length, 6);
});

test("chess.js tools report failures the model should see", async () => {
  const tools = chessTools();
  const h = await hashOf(tools);
  assert.match(((await tools.board_move({ move: "e2e4", position_hash: "0" })) as { error: string }).error, /^stale/);
  assert.match(((await tools.board_move({ move: "e2e5", position_hash: h })) as { error: string }).error, /^illegal move/);
  assert.match(((await tools.board_move({ move: "e4", position_hash: h })) as { error: string }).error, /^not a UCI move/);
});

// conformance/chess-tools.json: the Python tools' results for the move rules, the new tools, the board
// renderings and the brief (engines/py/tests/test_chess_tools.py writes it). The browser twin must match
// every one, byte for byte once canonical.
type Vector = { fen: string | null; moves: string[]; call: string; args: { [k: string]: unknown }; expect: unknown };
const vectors: Vector[] = JSON.parse(readFileSync(new URL("../../../conformance/chess-tools.json", import.meta.url), "utf8"));

test("chess.js tools reproduce the python-chess vectors", async () => {
  for (const v of vectors) {
    const tools = chessTools(v.fen ?? undefined);
    for (const m of v.moves) tools.game.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    const a = v.args;
    let got: unknown;
    if (v.call === "move_problem") got = moveProblem(tools.game, String(a.move));
    else if (v.call === "render_board") got = renderBoard(tools.game, String(a.fmt), String(a.orientation));
    else if (v.call === "turn_brief") {
      got = turnBrief(tools.game, {
        boardFormat: String(a.board_format), orientation: String(a.orientation),
        lastMove: (a.last_move as [string, string] | null) ?? null, noteMode: String(a.note_mode),
        noteText: (a.note_text as string | null) ?? null, noteLinesAdded: (a.note_lines_added as number | null) ?? null,
      });
    } else {
      const call = tools[v.call as "board_check" | "board_piece" | "board_history" | "board_resign" | "board_move"];
      got = await call(a);
      if (v.call === "board_resign") got = { ...(got as object), state_resigned: tools.resigned };
    }
    assert.deepEqual(got, v.expect, `${v.call} ${JSON.stringify(a)} on ${v.fen ?? "start"} after ${v.moves.join(" ")}`);
  }
  assert.equal(vectors.length, 108);
});
