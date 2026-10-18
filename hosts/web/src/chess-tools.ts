// Chess tools for the spec's §2 chess harness, on chess.js: the browser twin of the Python host's
// fausth.chess_tools (same results for the same game, so both hosts give the model the same tokens;
// conformance/chess-tools.json holds the vectors both are tested on). moveProblem, renderBoard and
// turnBrief are for hosts: the move rules a pre_tool handler denies with, and the user_prompt brief.
import { Chess } from "chess.js";
import type { Color, Square } from "chess.js";
import type { Answer } from "../../../engines/ts/src/engine.js";

type Args = { [k: string]: unknown };

const NOT_A_MOVE = "Not a move. Write it in UCI: from-square then to-square, e.g. g1f3, or e7e8q to promote.";
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const NAMES: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const GLYPHS: Record<string, string> = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙", k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const FILES = "abcdefgh";

const sq = (file: number, rank: number) => (FILES.charAt(file) + String(rank + 1)) as Square;
const fileOf = (s: string) => FILES.indexOf(s.charAt(0));
const rankOf = (s: string) => Number(s.charAt(1)) - 1;
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pieceName = (p: { type: string; color: Color }) => `${p.color === "w" ? "white" : "black"} ${NAMES[p.type]}`;
const on = (game: Chess, s: Square) => `${pieceName(game.get(s)!)} on ${s}`;
const uciOf = (m: { from: string; to: string; promotion?: string }) => m.from + m.to + (m.promotion ?? "");
const epSquare = (game: Chess) => game.fen({ forceEnpassantSquare: true }).split(" ")[3];

/** Whether the piece on `from` can get to `to` by its own movement, ignoring its king's safety (castling
 * aside): fausth.chess_tools._reaches, written out the same way. */
function reaches(game: Chess, from: Square, to: Square): boolean {
  const piece = game.get(from)!;
  const target = game.get(to);
  if (target && target.color === piece.color) return false;
  const df = fileOf(to) - fileOf(from);
  const dr = rankOf(to) - rankOf(from);
  if (piece.type === "n") return Math.min(Math.abs(df), Math.abs(dr)) === 1 && Math.max(Math.abs(df), Math.abs(dr)) === 2;
  if (piece.type === "k") return Math.max(Math.abs(df), Math.abs(dr)) === 1;
  if (piece.type === "p") {
    const ahead = piece.color === "w" ? 1 : -1;
    if (df === 0) {
      if (dr === ahead) return !target;
      const start = piece.color === "w" ? 1 : 6;
      return dr === 2 * ahead && rankOf(from) === start && !target && !game.get(sq(fileOf(from), rankOf(from) + ahead));
    }
    return Math.abs(df) === 1 && dr === ahead && (!!target || to === epSquare(game));
  }
  const straight = (df === 0) !== (dr === 0);
  const diagonal = Math.abs(df) === Math.abs(dr) && df !== 0;
  if (!((straight && (piece.type === "r" || piece.type === "q")) || (diagonal && (piece.type === "b" || piece.type === "q")))) return false;
  const [sf, sr] = [Math.sign(df), Math.sign(dr)];
  for (let f = fileOf(from) + sf, r = rankOf(from) + sr; f !== fileOf(to) || r !== rankOf(to); f += sf, r += sr) {
    if (game.get(sq(f, r))) return false;
  }
  return true;
}

/** The fixed sentence for a move that isn't legal (harness-lab harnesses/README.md), null if it is. */
export function moveProblem(game: Chess, move: string): string | null {
  if (!UCI.test(move)) return NOT_A_MOVE;
  if (game.moves({ verbose: true }).some((m) => uciOf(m) === move)) return null;
  const [from, to, promotion] = [move.slice(0, 2) as Square, move.slice(2, 4) as Square, move.slice(4)];
  const piece = game.get(from);
  if (!piece) return `There is no piece on ${from}.`;
  if (piece.color !== game.turn()) return `The ${pieceName(piece)} on ${from} is your opponent's.`;
  const promotes = piece.type === "p" && rankOf(to) === (piece.color === "w" ? 7 : 0);
  if (promotion && !promotes) return NOT_A_MOVE;
  if (promotes && !promotion && reaches(game, from, to)) return `Name the piece to promote to, e.g. ${move.slice(0, 4)}q.`;
  const home = piece.color === "w" ? "e1" : "e8";
  if (piece.type === "k" && from === home && rankOf(to) === rankOf(from) && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    return `You can't castle ${fileOf(to) > fileOf(from) ? "kingside" : "queenside"} now.`;
  }
  if (!reaches(game, from, to)) return `The ${pieceName(piece)} on ${from} can't move to ${to}.`;
  if (game.inCheck()) return `You are in check, and ${move} doesn't get you out of it.`;
  return `${move} would leave your king in check.`;
}

function kingOf(game: Chess, color: Color): Square | null {
  for (const row of game.board()) for (const cell of row) if (cell && cell.type === "k" && cell.color === color) return cell.square;
  return null;
}

/** python-chess's Board.is_pinned: on a line from its king, the first piece, with an enemy slider of that
 * line's kind next behind it. */
function pinned(game: Chess, square: Square, color: Color): boolean {
  const king = kingOf(game, color);
  if (!king || king === square) return false;
  const df = fileOf(square) - fileOf(king);
  const dr = rankOf(square) - rankOf(king);
  const straight = df === 0 || dr === 0;
  if (!straight && Math.abs(df) !== Math.abs(dr)) return false;
  const [sf, sr] = [Math.sign(df), Math.sign(dr)];
  let passed = false;
  for (let f = fileOf(king) + sf, r = rankOf(king) + sr; f >= 0 && f < 8 && r >= 0 && r < 8; f += sf, r += sr) {
    const s = sq(f, r);
    const p = game.get(s);
    if (!p) continue;
    if (!passed) {
      if (s !== square) return false;
      passed = true;
      continue;
    }
    return p.color !== color && (p.type === "q" || p.type === (straight ? "r" : "b"));
  }
  return false;
}

/** The position as text: fen | ascii | ascii_fen | pieces | unicode; `orientation` (white: White at the
 * bottom; mover: the side to move at the bottom) applies to the drawn formats. */
export function renderBoard(game: Chess, fmt: string, orientation = "white"): string {
  if (fmt === "fen") return game.fen();
  if (fmt === "pieces") {
    return (["w", "b"] as Color[]).map((color) => {
      const all = game.board().flat().filter((c) => c && c.color === color) as { square: Square; type: string }[];
      const pieces = ["k", "q", "r", "b", "n"].flatMap((t) => all.filter((c) => c.type === t).map((c) => c.square).sort(byName).map((s) => t.toUpperCase() + s));
      const pawns = all.filter((c) => c.type === "p").map((c) => c.square).sort(byName);
      return `${color === "w" ? "White" : "Black"}: ${pieces.join(" ")}` + (pawns.length ? `, pawns ${pawns.join(" ")}` : "");
    }).join("\n");
  }
  if (!["ascii", "ascii_fen", "unicode"].includes(fmt) || !["white", "mover"].includes(orientation)) {
    throw new Error(`unknown board format ${fmt} or orientation ${orientation}`);
  }
  const whiteBelow = orientation === "white" || game.turn() === "w";
  const order = whiteBelow ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = whiteBelow ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const rows = order.map((r) => `${r + 1} ` + files.map((f) => {
    const p = game.get(sq(f, r));
    const symbol = p ? (p.color === "w" ? p.type.toUpperCase() : p.type) : null;
    return fmt === "unicode" ? (symbol ? GLYPHS[symbol] : "·") : (symbol ?? ".");
  }).join(" "));
  rows.push("  " + files.map((f) => FILES[f]).join(" "));
  const text = rows.join("\n");
  return fmt === "ascii_fen" ? `${text}\nFEN: ${game.fen()}` : text;
}

function lineCount(text: string): number {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export type BriefOptions = {
  boardFormat: string;
  orientation: string;
  lastMove: [string, string] | null;
  noteMode: string;
  noteText: string | null;
  noteLinesAdded: number | null;
};

/** The text a user_prompt handler appends to the user message: the board, the opponent's last move
 * ([san, uci]), whether the side to move is in check, and the note as noteMode says. */
export function turnBrief(game: Chess, o: BriefOptions): string {
  const [mover, other] = game.turn() === "w" ? ["White", "Black"] : ["Black", "White"];
  const bottom = o.orientation === "white" ? "White" : mover;
  const parts: string[] = [];
  if (o.boardFormat === "fen") parts.push(`Position (FEN): ${game.fen()}`);
  else if (o.boardFormat === "pieces") parts.push("Pieces:", renderBoard(game, "pieces"));
  else {
    const legend = o.boardFormat === "unicode" ? "" : " (uppercase: White, lowercase: Black)";
    parts.push(`Board, ${bottom} at the bottom${legend}:`, renderBoard(game, o.boardFormat, o.orientation));
  }
  parts.push(o.lastMove ? `Last move: ${other} played ${o.lastMove[0]} (${o.lastMove[1]}).` : "Last move: none.");
  parts.push(`${mover} to move. You are ${game.inCheck() ? "" : "not "}in check.`);
  if (!["none", "count", "count_added", "full"].includes(o.noteMode)) throw new Error(`unknown note mode ${o.noteMode}`);
  const text = o.noteText ?? "";
  if (o.noteMode !== "none") {
    const n = lineCount(text);
    if (n === 0) parts.push("Your note is empty.");
    else if (o.noteMode === "full") parts.push("Your note:\n" + text.replace(/\n+$/, ""));
    else if (o.noteMode === "count_added" && o.noteLinesAdded !== null) {
      const added = o.noteLinesAdded === 0 ? "none" : String(o.noteLinesAdded);
      parts.push(`Your note has ${plural(n, "line")}, ${added} added since your last move.`);
    } else parts.push(`Your note has ${plural(n, "line")}.`);
  }
  return parts.join("\n");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The tools of one game, from `fen` (or the start position). */
export function chessTools(fen?: string) {
  const game = new Chess(fen);
  const positionHash = async () => (await sha256(game.fen())).slice(0, 16);
  const fail = (error: string): Answer => ({ ok: false, error });
  let resigned: string | null = null;
  return {
    game,
    /** The reason board_resign gave, null until it is called: the host ends the game on it. */
    get resigned() {
      return resigned;
    },
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
      if (args.position_hash !== undefined && args.position_hash !== (await positionHash())) return fail("stale position_hash: the position has changed; observe the board again");
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return fail(`not a UCI move: ${uci}`);
      let san: string;
      try {
        san = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
      } catch {
        return fail(`illegal move: ${uci}`);
      }
      return { ok: true, result: { played: uci, san, fen: game.fen(), position_hash: await positionHash() } };
    },
    async board_check(args: Args): Promise<Answer> {
      const move = String(args.move);
      const why = moveProblem(game, move);
      if (why !== null) return { ok: true, result: { move, legal: false, why } };
      const m = game.moves({ verbose: true }).find((x) => uciOf(x) === move)!;
      game.move(m);
      const givesCheck = game.inCheck();
      game.undo();
      const result: { [k: string]: string | boolean } = { move, legal: true, san: m.san, gives_check: givesCheck };
      if (m.isEnPassant()) result.captures = on(game, sq(fileOf(m.to), rankOf(m.from)));
      else if (m.captured) result.captures = on(game, m.to);
      return { ok: true, result };
    },
    async board_piece(args: Args): Promise<Answer> {
      const square = String(args.square);
      if (!/^[a-h][1-8]$/.test(square)) return fail(`not a square: ${square}`);
      const piece = game.get(square as Square);
      if (!piece) return fail(`There is no piece on ${square}.`);
      const color = piece.color;
      const enemy: Color = color === "w" ? "b" : "w";
      // A piece of the side not to move: where it could go if it were its turn.
      let mover = game;
      if (game.turn() !== color) {
        const f = game.fen().split(" ");
        [f[1], f[3]] = [color, "-"];
        mover = new Chess(f.join(" "), { skipValidation: true });
      }
      const to = new Set(mover.moves({ verbose: true, square: square as Square }).filter((m) => m.captured !== "k").map((m) => m.to));
      const occupied = game.board().flat().filter((c) => c && c.color === enemy) as { square: Square }[];
      const king = kingOf(game, color);
      const rights = game.getCastlingRights(color);
      return {
        ok: true,
        result: {
          square, piece: pieceName(piece),
          can_move_to: [...to].sort(byName),
          attacks: occupied.map((c) => c.square).filter((s) => game.attackers(s, color).includes(square as Square)).sort(byName).map((s) => on(game, s)),
          attacked_by: game.attackers(square as Square, enemy).sort(byName).map((s) => on(game, s)),
          defended_by: game.attackers(square as Square, color).sort(byName).map((s) => on(game, s)),
          pinned: pinned(game, square as Square, color),
          in_check: king !== null && game.isAttacked(king, enemy),
          can_castle_kingside: rights.k, can_castle_queenside: rights.q,
        },
      };
    },
    async board_history(args: Args): Promise<Answer> {
      const plies = game.history({ verbose: true }).map((m) => {
        const before = m.before.split(" ");
        return { number: Number(before[5]), white: before[1] === "w", san: m.san };
      });
      const shown = typeof args.last === "number" && args.last > 0 ? plies.slice(-args.last) : plies;
      const words = shown.map((p, i) => (p.white ? `${p.number}. ${p.san}` : i ? p.san : `${p.number}... ${p.san}`));
      return { ok: true, result: { moves: words.join(" "), plies: plies.length } };
    },
    async board_resign(args: Args): Promise<Answer> {
      resigned = String(args.reason ?? "");
      return { ok: true, result: { resigned: true } };
    },
  };
}
