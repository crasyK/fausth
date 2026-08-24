/**
 * Chess world adapter — board truth via chess.js; model never writes canonical state.
 */
import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import type { ToolHandler } from "../runtime.js";
import type { AgentIR, ToolResultEnvelope } from "../types.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type ChessWorld = {
  chess: Chess;
  moves_played: number;
  illegal_attempts: number;
  last_observe_hash: string;
  observed: 0 | 1;
};

export function positionHash(fen: string): string {
  return createHash("sha256").update(fen, "utf8").digest("hex").slice(0, 16);
}

export function legalMovesUci(chess: Chess): string[] {
  return chess
    .moves({ verbose: true })
    .map((m) => `${m.from}${m.to}${m.promotion ?? ""}`)
    .sort();
}

export function materialSummary(chess: Chess): { white: number; black: number } {
  const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const board = chess.board();
  let white = 0;
  let black = 0;
  for (const row of board) {
    for (const sq of row) {
      if (!sq) continue;
      const v = values[sq.type] ?? 0;
      if (sq.color === "w") white += v;
      else black += v;
    }
  }
  return { white, black };
}

/**
 * Distinct glyphs per side. cli-chess reuses one filled set + fg color; many
 * terminals ignore fg (or emoji-paint pieces), so white looked black and both
 * pawns were ♙. Outline = white, filled = black. FE0E = text presentation.
 */
const PIECES: Record<"w" | "b", Record<string, string>> = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};
const TEXT_PRES = "\uFE0E";

const ANSI = {
  reset: "\x1b[0m",
  lightSq: "\x1b[48;2;240;217;181m", // #f0d9b5
  darkSq: "\x1b[48;2;181;136;99m", // #b58863
  lastMove: "\x1b[48;2;205;210;106m",
  inCheck: "\x1b[48;2;227;90;90m",
  lightPiece: "\x1b[1m\x1b[38;2;255;255;255m",
  darkPiece: "\x1b[1m\x1b[38;2;20;20;20m",
  label: "\x1b[38;2;180;180;180m",
};

function pieceGlyph(color: "w" | "b", type: string): string {
  const g = PIECES[color][type] ?? "?";
  return g === "?" ? g : `${g}${TEXT_PRES}`;
}

export type BoardRenderOpts = {
  /** Highlight last move squares (UCI like e2e4 / e7e8q). */
  lastUci?: string;
  /** Use ANSI colors (cli-chess theme). Default true when stdout is a TTY. */
  color?: boolean;
};

function parseUciSquares(uci?: string): { from?: string; to?: string } {
  if (!uci) return {};
  const m = uci.toLowerCase().match(/^([a-h][1-8])([a-h][1-8])/);
  if (!m) return {};
  return { from: m[1], to: m[2] };
}

function squareName(file: number, rank: number): string {
  return `${"abcdefgh"[file]}${rank}`;
}

/**
 * cli-chess-inspired board: checkered colored squares, unicode pieces,
 * last-move + in-check highlights. Falls back to plain glyphs without color.
 */
export function formatAsciiBoard(chess: Chess, opts: BoardRenderOpts = {}): string {
  const useColor = opts.color ?? true;
  const { from: lastFrom, to: lastTo } = parseUciSquares(opts.lastUci);
  const rows = chess.board();
  const lines: string[] = [];

  const files = "a b c d e f g h";
  lines.push(useColor ? `${ANSI.label}  ${files}${ANSI.reset}` : `  ${files}`);

  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    let line = useColor ? `${ANSI.label}${rank}${ANSI.reset} ` : `${rank} `;
    for (let f = 0; f < 8; f++) {
      const sq = rows[r]![f];
      const name = squareName(f, rank);
      // a1 is dark: light when (file + rank) is even.
      const lightSquare = (f + rank) % 2 === 0;

      let pieceChar = " ";
      let pieceFg = "";
      if (sq) {
        pieceChar = pieceGlyph(sq.color, sq.type);
        pieceFg = sq.color === "w" ? ANSI.lightPiece : ANSI.darkPiece;
      }

      const inCheckSq =
        sq?.type === "k" &&
        ((sq.color === "w" && chess.turn() === "w" && chess.inCheck()) ||
          (sq.color === "b" && chess.turn() === "b" && chess.inCheck()));

      let bg = lightSquare ? ANSI.lightSq : ANSI.darkSq;
      if (name === lastFrom || name === lastTo) bg = ANSI.lastMove;
      if (inCheckSq) bg = ANSI.inCheck;

      // cli-chess cell width: piece + padding space
      const cell = `${pieceChar} `;
      if (useColor) {
        line += `${bg}${pieceFg}${cell}${ANSI.reset}`;
      } else {
        line += sq ? `${pieceChar} ` : "· ";
      }
    }
    lines.push(line.trimEnd());
  }

  return lines.join("\n");
}

export function terminalStatus(chess: Chess): {
  game_over: 0 | 1;
  result: "ongoing" | "checkmate" | "stalemate" | "draw" | "insufficient" | "repetition" | "fifty_move";
} {
  if (!chess.isGameOver()) return { game_over: 0, result: "ongoing" };
  if (chess.isCheckmate()) return { game_over: 1, result: "checkmate" };
  if (chess.isStalemate()) return { game_over: 1, result: "stalemate" };
  if (chess.isInsufficientMaterial()) return { game_over: 1, result: "insufficient" };
  if (chess.isThreefoldRepetition()) return { game_over: 1, result: "repetition" };
  if (chess.isDraw()) return { game_over: 1, result: "draw" };
  return { game_over: 1, result: "draw" };
}

export function chessWorldFromAgent(agent: AgentIR): ChessWorld {
  const fen = String(agent.state.fen ?? START_FEN);
  const chess = new Chess(fen);
  return {
    chess,
    moves_played: Number(agent.state.moves_played ?? 0),
    illegal_attempts: Number(agent.state.illegal_attempts ?? 0),
    last_observe_hash: String(agent.state.position_hash ?? positionHash(fen)),
    observed: Number(agent.state.observed ?? 0) === 1 ? 1 : 0,
  };
}

export function observeOutput(world: ChessWorld): Record<string, unknown> {
  const fen = world.chess.fen();
  const legal = legalMovesUci(world.chess);
  const mat = materialSummary(world.chess);
  const term = terminalStatus(world.chess);
  return {
    fen,
    side: world.chess.turn(),
    legal_moves: legal,
    in_check: world.chess.inCheck() ? 1 : 0,
    material_white: mat.white,
    material_black: mat.black,
    moves_played: world.moves_played,
    game_over: term.game_over,
    result: term.result,
    position_hash: positionHash(fen),
  };
}

function parseUciMove(uci: string): { from: string; to: string; promotion?: string } | null {
  const m = uci.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
  if (!m) return null;
  return { from: m[1]!, to: m[2]!, promotion: m[3]?.toLowerCase() };
}

export function agentUsesChess(agent: AgentIR): boolean {
  return agent.tools.some((t) => t.id === "board.observe" || t.id === "board.move" || t.id === "game.claim");
}

export function createChessTools(world: ChessWorld): Record<string, ToolHandler> {
  return {
    "board.observe": (): ToolResultEnvelope => {
      const out = observeOutput(world);
      world.last_observe_hash = String(out.position_hash);
      world.observed = 1;
      return {
        output: out,
        state_transition: {
          set: {
            fen: out.fen,
            position_hash: out.position_hash,
            observed: 1,
            game_over: out.game_over,
            side: out.side,
          },
        },
      };
    },
    "board.move": (args, ctx): ToolResultEnvelope => {
      const move = String(args.move ?? "").toLowerCase();
      const fromHash = String(args.position_hash ?? "");
      const currentHash = positionHash(world.chess.fen());

      if (fromHash && fromHash !== currentHash) {
        return {
          output: {
            ok: 0,
            illegal: 0,
            stale: 1,
            move,
            position_hash: currentHash,
            expected_hash: fromHash,
            error: "stale_position",
          },
        };
      }

      const legal = legalMovesUci(world.chess);
      if (!legal.includes(move)) {
        world.illegal_attempts += 1;
        return {
          output: {
            ok: 0,
            illegal: 1,
            stale: 0,
            move,
            legal_moves: legal,
            error: "illegal_move",
          },
          state_transition: { set: { illegal_attempts: world.illegal_attempts } },
        };
      }

      const parsed = parseUciMove(move);
      if (!parsed) {
        world.illegal_attempts += 1;
        return {
          output: { ok: 0, illegal: 1, move, error: "invalid_uci" },
          state_transition: { set: { illegal_attempts: world.illegal_attempts } },
        };
      }

      const result = world.chess.move({
        from: parsed.from,
        to: parsed.to,
        promotion: parsed.promotion as "q" | "r" | "b" | "n" | undefined,
      });
      if (!result) {
        world.illegal_attempts += 1;
        return {
          output: { ok: 0, illegal: 1, move, error: "move_rejected" },
          state_transition: { set: { illegal_attempts: world.illegal_attempts } },
        };
      }

      world.moves_played += 1;
      world.observed = 0;
      const fen = world.chess.fen();
      const term = terminalStatus(world.chess);
      const newHash = positionHash(fen);
      world.last_observe_hash = newHash;

      return {
        output: {
          ok: 1,
          illegal: 0,
          stale: 0,
          move,
          fen,
          san: result.san,
          position_hash: newHash,
          game_over: term.game_over,
          result: term.result,
        },
        state_transition: {
          set: {
            fen,
            position_hash: newHash,
            moves_played: world.moves_played,
            observed: 0,
            game_over: term.game_over,
            side: world.chess.turn(),
          },
        },
      };
    },
    "game.claim": (args, ctx): ToolResultEnvelope => {
      const kind = String(args.kind ?? "");
      const evidence = Number(ctx.state.observed ?? world.observed);
      if (evidence !== 1) {
        return {
          output: { ok: 0, kind, error: "claim_without_evidence" },
        };
      }

      const term = terminalStatus(world.chess);
      if (term.game_over !== 1) {
        return {
          output: { ok: 0, kind, error: "game_not_terminal", result: term.result },
        };
      }

      const valid =
        (kind === "checkmate" && term.result === "checkmate") ||
        (kind === "draw" && term.result !== "checkmate" && term.result !== "ongoing") ||
        (kind === "stalemate" && term.result === "stalemate");

      if (!valid) {
        return {
          output: {
            ok: 0,
            kind,
            error: "claim_mismatch",
            actual_result: term.result,
          },
        };
      }

      return {
        output: { ok: 1, kind, result: term.result, fen: world.chess.fen() },
        state_transition: { set: { claimed: 1, game_over: 1 } },
      };
    },
  };
}

/** Replay hash over move sequence for determinism checks. */
export function replayHashFromMoves(moves: string[], startFen = START_FEN): string {
  const chess = new Chess(startFen);
  for (const m of moves) {
    const parsed = parseUciMove(m);
    if (!parsed) throw new Error(`invalid uci: ${m}`);
    chess.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion as "q" | undefined });
  }
  return positionHash(chess.fen());
}
