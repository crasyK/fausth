// Chess tools for the spec's §2 chess harness, on chess.js: the browser twin of the Python host's
// fausth.chess_tools (same results for the same game, so both hosts give the model the same tokens).
import { Chess } from "chess.js";
import type { Answer } from "../../../engines/ts/src/engine.js";

type Args = { [k: string]: unknown };

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The tools of one game, from `fen` (or the start position). */
export function chessTools(fen?: string) {
  const game = new Chess(fen);
  const positionHash = async () => (await sha256(game.fen())).slice(0, 16);
  const fail = (error: string): Answer => ({ ok: false, error });
  return {
    game,
    async board_observe(): Promise<Answer> {
      return { ok: true, result: { fen: game.fen(), side_to_move: game.turn() === "w" ? "white" : "black", in_check: game.inCheck(), position_hash: await positionHash() } };
    },
    async board_legal_moves(): Promise<Answer> {
      const moves = game.moves({ verbose: true }).map((m) => ({ uci: m.from + m.to + (m.promotion ?? ""), san: m.san }));
      moves.sort((a, b) => (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0));
      return { ok: true, result: { moves } };
    },
    async board_move(args: Args): Promise<Answer> {
      const uci = String(args.move);
      if (args.position_hash !== (await positionHash())) return fail("stale position_hash: the position has changed; observe the board again");
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return fail(`not a UCI move: ${uci}`);
      let san: string;
      try {
        san = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
      } catch {
        return fail(`illegal move: ${uci}`);
      }
      return { ok: true, result: { played: uci, san, fen: game.fen(), position_hash: await positionHash() } };
    },
  };
}
