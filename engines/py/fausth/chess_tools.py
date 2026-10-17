"""Chess tools for the spec's §2 chess harness, on python-chess (host side). Script bindings: each
takes (args, state); the board lives in `state["board"]`, created from `state["fen"]` if given."""
from __future__ import annotations

import hashlib
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
    if args["position_hash"] != position_hash(board):
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
