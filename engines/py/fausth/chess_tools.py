"""Chess tools for the spec's §2 chess harness, on python-chess (host side). Script bindings: each
takes (args, state); the board lives in `state["board"]`, created from `state["fen"]` if given.

`hosts/web/src/chess-tools.ts` is the browser twin: the same results for the same game, so both hosts
give the model the same tokens (`conformance/chess-tools.json` holds the vectors both are tested on).
`move_problem`, `render_board` and `turn_brief` are for hosts: the move rules a `pre_tool` handler
denies with, and the brief a `user_prompt` handler appends to the user message."""
from __future__ import annotations

import hashlib
import re
from typing import Any

import chess

from .host import ToolError


def _board(state: dict[str, Any]) -> chess.Board:
    if "board" not in state:
        state["board"] = chess.Board(state["fen"]) if state.get("fen") else chess.Board()
    return state["board"]


def position_hash(board: chess.Board) -> str:
    return hashlib.sha256(board.fen().encode()).hexdigest()[:16]


def board_observe(args: Any, state: dict[str, Any]) -> dict[str, Any]:
    board = _board(state)
    return {"fen": board.fen(), "side_to_move": "white" if board.turn else "black", "in_check": board.is_check(),
            "position_hash": position_hash(board)}


def board_legal_moves(args: Any, state: dict[str, Any]) -> dict[str, Any]:
    board = _board(state)
    return {"moves": [{"uci": m.uci(), "san": board.san(m)} for m in sorted(board.legal_moves, key=lambda m: m.uci())]}


def board_move(args: Any, state: dict[str, Any]) -> dict[str, Any]:
    board = _board(state)
    if "position_hash" in args and args["position_hash"] != position_hash(board):
        raise ToolError("stale position_hash: the position has changed; observe the board again")
    try:
        move = chess.Move.from_uci(args["move"])
    except ValueError:
        raise ToolError(f"not a UCI move: {args['move']}") from None
    if move not in board.legal_moves:
        raise ToolError(f"illegal move: {args['move']}")
    san = board.san(move)
    board.push(move)
    return {"played": move.uci(), "san": san, "fen": board.fen(), "position_hash": position_hash(board)}


# The move rules: the sentence a model sees for a move that isn't legal, the first that applies.
NOT_A_MOVE = "Not a move. Write it in UCI: from-square then to-square, e.g. g1f3, or e7e8q to promote."
ONLY_PAWNS_PROMOTE = "Only a pawn reaching the last rank can promote."
UCI = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$")
NAMES = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop", chess.ROOK: "rook", chess.QUEEN: "queen",
         chess.KING: "king"}
GLYPHS = {"K": "♔", "Q": "♕", "R": "♖", "B": "♗", "N": "♘", "P": "♙", "k": "♚", "q": "♛", "r": "♜", "b": "♝", "n": "♞",
          "p": "♟"}


def _name(piece: chess.Piece) -> str:
    return f"{'white' if piece.color else 'black'} {NAMES[piece.piece_type]}"


def _on(board: chess.Board, square: int) -> str:
    return f"{_name(board.piece_at(square))} on {chess.square_name(square)}"


def _reaches(board: chess.Board, frm: int, to: int) -> bool:
    """Whether the piece on `frm` can get to `to` by its own movement, ignoring its king's safety
    (castling aside). Written out rather than taken from python-chess, so the browser twin can match it."""
    piece = board.piece_at(frm)
    target = board.piece_at(to)
    if target is not None and target.color == piece.color:
        return False
    df = chess.square_file(to) - chess.square_file(frm)
    dr = chess.square_rank(to) - chess.square_rank(frm)
    kind = piece.piece_type
    if kind == chess.KNIGHT:
        return {abs(df), abs(dr)} == {1, 2}
    if kind == chess.KING:
        return max(abs(df), abs(dr)) == 1
    if kind == chess.PAWN:
        ahead = 1 if piece.color else -1
        if df == 0:
            if dr == ahead:
                return target is None
            start = 1 if piece.color else 6
            return dr == 2 * ahead and chess.square_rank(frm) == start and target is None \
                and board.piece_at(frm + 8 * ahead) is None
        return abs(df) == 1 and dr == ahead and (target is not None or to == board.ep_square)
    straight, diagonal = (df == 0) != (dr == 0), abs(df) == abs(dr) != 0
    if not (straight and kind in (chess.ROOK, chess.QUEEN) or diagonal and kind in (chess.BISHOP, chess.QUEEN)):
        return False
    step = (df > 0) - (df < 0) + 8 * ((dr > 0) - (dr < 0))
    return all(board.piece_at(sq) is None for sq in range(frm + step, to, step))


def move_problem(board: chess.Board, move: str) -> str | None:
    """The fixed sentence for a move that isn't legal (harness-lab harnesses/README.md), None if it is."""
    if not UCI.match(move):
        return NOT_A_MOVE
    if any(m.uci() == move for m in board.legal_moves):
        return None
    frm, to, promotion = chess.parse_square(move[:2]), chess.parse_square(move[2:4]), move[4:]
    piece = board.piece_at(frm)
    if piece is None:
        return f"There is no piece on {move[:2]}."
    if piece.color != board.turn:
        return f"The {_name(piece)} on {move[:2]} is your opponent's."
    last_rank = 7 if piece.color else 0
    promotes = piece.piece_type == chess.PAWN and chess.square_rank(to) == last_rank
    if promotes and not promotion and _reaches(board, frm, to):
        return f"Name the piece to promote to, e.g. {move[:4]}q."
    if promotion and not promotes:
        return ONLY_PAWNS_PROMOTE
    home = chess.E1 if piece.color else chess.E8
    if piece.piece_type == chess.KING and frm == home and to in (home + 2, home - 2):
        return f"You can't castle {'kingside' if to > frm else 'queenside'} now."
    if not _reaches(board, frm, to):
        return f"The {_name(piece)} on {move[:2]} can't move to {move[2:4]}."
    if board.is_check():
        return f"You are in check, and {move} doesn't get you out of it."
    return f"{move} would leave your king in check."


def board_check(args: Any, state: dict[str, Any]) -> dict[str, Any]:
    board = _board(state)
    why = move_problem(board, args["move"])
    if why is not None:
        return {"move": args["move"], "legal": False, "why": why}
    move = chess.Move.from_uci(args["move"])
    result = {"move": args["move"], "legal": True, "san": board.san(move), "gives_check": board.gives_check(move)}
    if board.is_en_passant(move):
        result["captures"] = _on(board, move.to_square + (-8 if board.turn else 8))
    elif board.piece_at(move.to_square) is not None:
        result["captures"] = _on(board, move.to_square)
    return result


def board_piece(args: Any, state: dict[str, Any]) -> dict[str, Any]:
    board = _board(state)
    if not re.match(r"^[a-h][1-8]$", str(args["square"])):
        raise ToolError(f"not a square: {args['square']}")
    square = chess.parse_square(args["square"])
    piece = board.piece_at(square)
    if piece is None:
        raise ToolError(f"There is no piece on {args['square']}.")
    color = piece.color
    # A piece of the side not to move: where it could go if it were its turn.
    mover = board.copy(stack=False)
    if mover.turn != color:
        mover.turn, mover.ep_square = color, None
    to = {m.to_square for m in mover.legal_moves if m.from_square == square and mover.piece_type_at(m.to_square) != chess.KING}
    king = board.king(color)
    return {
        "square": args["square"], "piece": _name(piece),
        "can_move_to": sorted(chess.square_name(s) for s in to),
        "attacks": [_on(board, s) for s in sorted(board.attacks(square) & board.occupied_co[not color], key=chess.square_name)],
        "attacked_by": [_on(board, s) for s in sorted(board.attackers(not color, square), key=chess.square_name)],
        "defended_by": [_on(board, s) for s in sorted(board.attackers(color, square), key=chess.square_name)],
        "pinned": board.is_pinned(color, square) if piece.piece_type != chess.KING else False,
        "in_check": king is not None and board.is_attacked_by(not color, king),
        "castling_right_kingside": board.has_kingside_castling_rights(color),
        "castling_right_queenside": board.has_queenside_castling_rights(color),
    }


def board_history(args: Any, state: dict[str, Any]) -> dict[str, Any]:
    board = _board(state)
    plies = []
    replay = board.root()
    for move in board.move_stack:
        plies.append((replay.fullmove_number, replay.turn, replay.san(move)))
        replay.push(move)
    shown = plies[-args["last"]:] if args.get("last") else plies
    words: list[str] = []
    for i, (number, white, san) in enumerate(shown):
        words.append(f"{number}. {san}" if white else (san if i else f"{number}... {san}"))
    return {"moves": " ".join(words), "plies": len(plies)}


def board_resign(args: Any, state: dict[str, Any]) -> dict[str, Any]:
    state["resigned"] = args.get("reason", "")
    return {"resigned": True}


def render_board(board: chess.Board, fmt: str, orientation: str = "white") -> str:
    """The position as text: fen | ascii | ascii_fen | pieces | unicode. `orientation` (white: White
    at the bottom; mover: the side to move at the bottom) applies to the drawn formats."""
    if fmt == "fen":
        return board.fen()
    if fmt == "pieces":
        lines = []
        for color in (chess.WHITE, chess.BLACK):
            pieces = [chess.piece_symbol(kind).upper() + chess.square_name(s)
                      for kind in (chess.KING, chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT)
                      for s in sorted(board.pieces(kind, color), key=chess.square_name)]
            pawns = sorted((chess.square_name(s) for s in board.pieces(chess.PAWN, color)))
            line = f"{'White' if color else 'Black'}: {' '.join(pieces)}"
            lines.append(line + (f", pawns {' '.join(pawns)}" if pawns else ""))
        return "\n".join(lines)
    if fmt not in ("ascii", "ascii_fen", "unicode") or orientation not in ("white", "mover"):
        raise ValueError(f"unknown board format {fmt!r} or orientation {orientation!r}")
    white_below = orientation == "white" or board.turn == chess.WHITE
    ranks = range(7, -1, -1) if white_below else range(8)
    files = range(8) if white_below else range(7, -1, -1)
    rows = []
    for r in ranks:
        cells = []
        for f in files:
            piece = board.piece_at(chess.square(f, r))
            symbol = piece.symbol() if piece else None
            cells.append((GLYPHS[symbol] if symbol else "·") if fmt == "unicode" else (symbol or "."))
        rows.append(f"{r + 1} {' '.join(cells)}")
    rows.append("  " + " ".join(chess.FILE_NAMES[f] for f in files))
    text = "\n".join(rows)
    return text + f"\nFEN: {board.fen()}" if fmt == "ascii_fen" else text


def _lines(text: str) -> int:
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return len(lines)


def _count(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def turn_brief(board: chess.Board, *, board_format: str, orientation: str, last_move: tuple[str, str] | None,
               note_mode: str, note_text: str | None, note_lines_added: int | None) -> str:
    """The text a `user_prompt` handler appends to the user message: the board, the opponent's last move
    (`(san, uci)`), whether the side to move is in check, and the note as `note_mode` says."""
    mover, other = ("White", "Black") if board.turn else ("Black", "White")
    bottom = "White" if orientation == "white" else mover
    if board_format == "fen":
        parts = [f"Position (FEN): {board.fen()}"]
    elif board_format == "pieces":
        parts = ["Pieces:", render_board(board, "pieces")]
    else:
        legend = "" if board_format == "unicode" else " (uppercase: White, lowercase: Black)"
        parts = [f"Board, {bottom} at the bottom{legend}:", render_board(board, board_format, orientation)]
    parts.append(f"Last move: {other} played {last_move[0]} ({last_move[1]})." if last_move else "Last move: none.")
    parts.append(f"{mover} to move. You are {'' if board.is_check() else 'not '}in check.")
    if note_mode not in ("none", "count", "count_added", "full"):
        raise ValueError(f"unknown note mode {note_mode!r}")
    text = note_text or ""
    if note_mode != "none":
        n = _lines(text)
        if n == 0:
            parts.append("Your note is empty.")
        elif note_mode == "full":
            parts.append("Your note:\n" + text.rstrip("\n"))
        elif note_mode == "count_added" and note_lines_added is not None:
            added = "none" if note_lines_added == 0 else str(note_lines_added)
            parts.append(f"Your note has {_count(n, 'line')}, {added} added since your last move.")
        else:
            parts.append(f"Your note has {_count(n, 'line')}.")
    return "\n".join(parts)
