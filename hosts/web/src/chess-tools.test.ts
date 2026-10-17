import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chessTools } from "./chess-tools.js";

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
