"""The chess tools for hosts: the move rules, the new tools and the brief. Their results are tokens a
model sees, so `conformance/chess-tools.json` records them and the browser twin must reproduce them
(`hosts/web/src/chess-tools.test.ts`). FAUSTH_WRITE_VECTORS=1 rewrites that file from these cases."""
import json
import os
from pathlib import Path

import chess
import pytest

from fausth import chess_tools
from fausth.host import ToolError

VECTORS = Path(__file__).resolve().parents[3] / "conformance" / "chess-tools.json"

START = None
CASTLE = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
CASTLE_THROUGH_CHECK = "r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1"
CASTLE_NO_RIGHTS = "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1"
CASTLE_BLOCKED = "r3k2r/8/8/8/8/8/8/RN2K1NR w KQkq - 0 1"
CASTLE_BLACK = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"
EN_PASSANT = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3"
EN_PASSANT_PINNED = "8/8/8/K2pP2q/8/8/8/7k w - d6 0 1"
PROMOTION = "8/P7/8/8/8/8/8/k6K w - - 0 1"
PROMOTION_BLOCKED = "n7/P7/8/8/8/8/8/k6K w - - 0 1"
CHECK = "4k3/4r3/8/8/8/8/P7/4K3 w - - 0 1"
PIN = "4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1"
DOUBLE_CHECK = "4k3/8/8/8/1b6/8/2N5/r3K3 w - - 0 1"
MATE_IN_ONE = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1"
STALEMATE = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"
MIDGAME = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 3 10"
OPENING = ["e2e4", "e7e5", "g1f3", "b8c6"]

# (fen, moves played first, call, args)
CASES = [
    *[(START, [], "move_problem", {"move": m}) for m in ["e2e4", "Nf3", "e2e4+", "e7e8Q", "0000", "e4e5", "e7e5", "g1g3", "a1a3", "h1h1", "e2e4q", "g1f3q"]],
    *[(CASTLE, [], "move_problem", {"move": m}) for m in ["e1g1", "e1c1", "e1e3"]],
    *[(CASTLE_THROUGH_CHECK, [], "move_problem", {"move": m}) for m in ["e1g1", "e1c1"]],
    *[(CASTLE_NO_RIGHTS, [], "move_problem", {"move": m}) for m in ["e1g1", "e1c1"]],
    *[(CASTLE_BLOCKED, [], "move_problem", {"move": m}) for m in ["e1g1", "e1c1"]],
    *[(CASTLE_BLACK, [], "move_problem", {"move": m}) for m in ["e8g8", "e1g1"]],
    *[(EN_PASSANT, [], "move_problem", {"move": m}) for m in ["e5f6", "e5d6"]],
    (EN_PASSANT_PINNED, [], "move_problem", {"move": "e5d6"}),
    *[(PROMOTION, [], "move_problem", {"move": m}) for m in ["a7a8", "a7a8q", "a7a8n", "a7b8q", "h1g1q", "h1g1"]],
    (PROMOTION_BLOCKED, [], "move_problem", {"move": "a7a8"}),
    *[(CHECK, [], "move_problem", {"move": m}) for m in ["a2a3", "e1e2", "e1d1"]],
    *[(PIN, [], "move_problem", {"move": m}) for m in ["e2d3", "e2e3", "e1d1"]],
    *[(DOUBLE_CHECK, [], "move_problem", {"move": m}) for m in ["c2a1", "c2b4", "e1e2", "e1d2"]],
    *[(STALEMATE, [], "move_problem", {"move": m}) for m in ["h8g8", "h8h7"]],
    (START, [], "board_check", {"move": "g1f3"}),
    (START, [], "board_check", {"move": "g1g3"}),
    (START, ["e2e4", "d7d5"], "board_check", {"move": "e4d5"}),
    (EN_PASSANT, [], "board_check", {"move": "e5f6"}),
    (MATE_IN_ONE, [], "board_check", {"move": "a1a8"}),
    (PROMOTION, [], "board_check", {"move": "a7a8q"}),
    (CASTLE, [], "board_check", {"move": "e1g1"}),
    (START, [], "board_piece", {"square": "g1"}),
    (START, [], "board_piece", {"square": "e1"}),
    (START, [], "board_piece", {"square": "e4"}),
    (START, [], "board_piece", {"square": "z9"}),
    (START, ["e2e4", "d7d5"], "board_piece", {"square": "e4"}),
    (PIN, [], "board_piece", {"square": "e2"}),
    (PIN, [], "board_piece", {"square": "e7"}),
    (DOUBLE_CHECK, [], "board_piece", {"square": "e1"}),
    (STALEMATE, [], "board_piece", {"square": "h8"}),
    (EN_PASSANT, [], "board_piece", {"square": "e5"}),
    (CASTLE_THROUGH_CHECK, [], "board_piece", {"square": "e1"}),
    (CASTLE_BLACK, [], "board_piece", {"square": "a1"}),
    (START, [], "board_history", {}),
    (START, OPENING, "board_history", {}),
    (START, OPENING, "board_history", {"last": 3}),
    (START, OPENING, "board_history", {"last": 2}),
    (MIDGAME, ["g8f6", "b1c3", "f8c5"], "board_history", {}),
    (MIDGAME, ["g8f6", "b1c3", "f8c5"], "board_history", {"last": 2}),
    (START, [], "board_resign", {"reason": "lost on material"}),
    (START, [], "board_move", {"move": "e2e4", "reason": "takes the center"}),
    *[(fen, moves, "render_board", {"fmt": fmt, "orientation": o})
      for fen, moves in [(START, ["e2e4"]), (EN_PASSANT_PINNED, []), (PROMOTION, [])]
      for fmt in ["fen", "ascii", "ascii_fen", "pieces", "unicode"] for o in ["white", "mover"]],
    *[(fen, moves, "turn_brief", brief) for fen, moves, brief in [
        (START, OPENING[:3], {"board_format": "ascii", "orientation": "white", "last_move": ["Nf3", "g1f3"],
                              "note_mode": "count_added", "note_text": "Plan: castle short.\nWatch f7.\n", "note_lines_added": 1}),
        (START, OPENING[:3], {"board_format": "ascii", "orientation": "mover", "last_move": ["Nf3", "g1f3"],
                              "note_mode": "count_added", "note_text": "one line", "note_lines_added": 0}),
        (CHECK, [], {"board_format": "fen", "orientation": "white", "last_move": None,
                     "note_mode": "none", "note_text": None, "note_lines_added": None}),
        (PIN, [], {"board_format": "pieces", "orientation": "white", "last_move": ["Re7", "e8e7"],
                   "note_mode": "count", "note_text": "", "note_lines_added": None}),
        (CASTLE_BLACK, [], {"board_format": "unicode", "orientation": "mover", "last_move": ["Rh1", "h2h1"],
                            "note_mode": "full", "note_text": "Last move: nothing new.\nWeaknesses: none.\n\n",
                            "note_lines_added": None}),
        (EN_PASSANT, [], {"board_format": "ascii_fen", "orientation": "white", "last_move": ["f5", "f7f5"],
                          "note_mode": "count_added", "note_text": "a\nb", "note_lines_added": None}),
        (START, OPENING[:3], {"board_format": "pieces", "orientation": "white", "last_move": ["Nf3", "g1f3"],
                              "note_mode": "full", "note_text": "Plan: castle short.", "note_lines_added": None,
                              "history": "moves"}),
        (START, [], {"board_format": "ascii", "orientation": "white", "last_move": None,
                     "note_mode": "none", "note_text": None, "note_lines_added": None, "history": "moves"}),
        (MIDGAME, ["g8f6", "b1c3", "f8c5"], {"board_format": "fen", "orientation": "white", "last_move": ["Bc5", "f8c5"],
                                             "note_mode": "count", "note_text": "x", "note_lines_added": None,
                                             "history": "moves"}),
    ]],
]


def run_case(fen, moves, call, args):
    state = {"fen": fen} if fen else {}
    board = chess_tools._board(state)
    for m in moves:
        board.push_uci(m)
    if call == "move_problem":
        return chess_tools.move_problem(board, args["move"])
    if call == "render_board":
        return chess_tools.render_board(board, args["fmt"], args["orientation"])
    if call == "turn_brief":
        brief = dict(args, last_move=tuple(args["last_move"]) if args["last_move"] else None)
        return chess_tools.turn_brief(board, **brief)
    try:
        result = {"ok": True, "result": getattr(chess_tools, call)(args, state)}
    except ToolError as e:
        result = {"ok": False, "error": str(e)}
    if call == "board_resign":
        result["state_resigned"] = state.get("resigned")
    return result


def vectors():
    return [{"fen": fen, "moves": moves, "call": call, "args": args, "expect": run_case(fen, moves, call, args)}
            for fen, moves, call, args in CASES]


def test_the_vectors_match_the_python_tools():
    built = json.dumps(vectors(), indent=1, ensure_ascii=False) + "\n"
    if os.environ.get("FAUSTH_WRITE_VECTORS"):
        VECTORS.write_text(built, "utf-8")
    assert VECTORS.read_text("utf-8") == built


def problem(fen, move, moves=()):
    board = chess.Board(fen) if fen else chess.Board()
    for m in moves:
        board.push_uci(m)
    return chess_tools.move_problem(board, move)


def test_each_move_rule_has_its_sentence():
    assert problem(START, "Nf3") == chess_tools.NOT_A_MOVE  # 1
    assert problem(START, "e4e5") == "There is no piece on e4."  # 2
    assert problem(START, "e7e5") == "The black pawn on e7 is your opponent's."  # 3
    assert problem(PROMOTION, "a7a8") == "Name the piece to promote to, e.g. a7a8q."  # 4
    assert problem(PROMOTION, "h1g1q") == "Only a pawn reaching the last rank can promote."  # 5: not a pawn
    assert problem(START, "e2e4q") == "Only a pawn reaching the last rank can promote."  # 5: not the last rank
    assert problem(CASTLE_THROUGH_CHECK, "e1g1") == "You can't castle kingside now."  # 6
    assert problem(CASTLE_NO_RIGHTS, "e1c1") == "You can't castle queenside now."
    assert problem(START, "g1g3") == "The white knight on g1 can't move to g3."  # 7
    assert problem(CHECK, "a2a3") == "You are in check, and a2a3 doesn't get you out of it."  # 8
    assert problem(PIN, "e2d3") == "e2d3 would leave your king in check."  # 9


def test_the_rules_apply_in_order_and_legal_moves_pass():
    assert problem(START, "e2e4") is None
    assert problem(PROMOTION, "a7a8q") is None
    assert problem(CASTLE, "e1g1") is None
    assert problem(START, "e7e5q") == "The black pawn on e7 is your opponent's."  # before the promotion rules
    assert problem(PROMOTION_BLOCKED, "a7a8") == "The white pawn on a7 can't move to a8."  # no promotion to name
    assert problem(DOUBLE_CHECK, "c2a1") == "You are in check, and c2a1 doesn't get you out of it."
    assert problem(EN_PASSANT_PINNED, "e5d6") == "e5d6 would leave your king in check."
    assert problem(STALEMATE, "h8g8") == "h8g8 would leave your king in check."


def test_board_piece_and_resign_report_to_the_model_and_the_host():
    with pytest.raises(ToolError, match="There is no piece on e4."):
        chess_tools.board_piece({"square": "e4"}, {})
    state = {"fen": PIN}
    assert chess_tools.board_piece({"square": "e2"}, state)["pinned"] is True
    assert chess_tools.board_resign({"reason": "r"}, state) == {"resigned": True}
    assert state["resigned"] == "r"


def test_the_brief_lists_the_moves_only_when_asked():
    board = chess.Board()
    for m in ["e2e4", "e7e5", "g1f3"]:
        board.push_uci(m)
    common = {"board_format": "pieces", "orientation": "white", "last_move": ("Nf3", "g1f3"), "note_mode": "none",
              "note_text": None, "note_lines_added": None}
    plain = chess_tools.turn_brief(board, **common)
    assert chess_tools.turn_brief(board, **common, history="none") == plain
    lines = chess_tools.turn_brief(board, **common, history="moves").splitlines()
    assert lines[lines.index("Moves so far: 1. e4 e5 2. Nf3") + 1] == "Last move: White played Nf3 (g1f3)."
    assert "Moves so far: none." in chess_tools.turn_brief(chess.Board(), **dict(common, last_move=None), history="moves")
    with pytest.raises(ValueError):
        chess_tools.turn_brief(board, **common, history="all")


def test_board_move_without_position_hash_skips_the_staleness_check():
    state = {}
    assert chess_tools.board_move({"move": "e2e4", "reason": "r"}, state)["san"] == "e4"
