# Chess two-model series report

**Study:** `chess-procedural-wind-tunnel`  
**Run id:** live series under `live/reports/chess-series/`  
**Window:** 2026-08-04 ≈14:27–19:06 UTC (~4.7h)  
**Status:** stopped at **16 / 20** games (process exited; enough for analysis)  
**Interactive summary:** Cursor canvas `chess-series-analysis` (local IDE; not in this git tree). Narrative: this file.

---

## 1. Executive summary

Two KIT models played under the **legality-gated** chess harness with alternating colors. The series measures **procedural honesty** (observe → move, illegal/stale deny, shared board truth), not playing strength.

| Metric | Value |
|--------|------:|
| Games completed | 16 / 20 |
| Legal plies executed | 641 |
| Illegal attempts (denied, no board mutate) | 31 |
| Chess terminals (mate / Patt / 3-fold / draw) | **0** |
| Infra aborts (minimax unavailable on KIT) | 10 |
| Protocol aborts (`no_legal_move` / empty tool proposal) | 5 |
| Ply-cap (200 moves, still ongoing) | 1 |
| Checkmate wins | 0 |

**Bottom line:** Harness gates held. Outcomes were dominated by **KIT availability** and **minimax failing to call tools**, not by chess end conditions. Mistral was far more reliable on the tool protocol.

---

## 2. Harness structure

### 2.1 Case-study layout

```
case-studies/chess/
  manifest.yml                 # study matrix (3 harness conditions)
  harnesses/
    legality-gated/            # PRIMARY — used for the live series
      agent.yml
      deployment.fixture.yml   # recorded / Track A
    permissive-control/        # control: no sequence / move verify
    oriented/                  # gated + orientation emit
  deployments/
    kit.yml                    # live KIT binding (series)
    openrouter-free.yml
    local-recorded.yml
  tasks/start-position/
  expected/scoring.yml
  results/                     # Track A + this report
```

World / adapter (board truth):

- `worlds/chess/` — catalog
- `engines/ts/src/adapters/chess.ts` — `chess.js` owns FEN/legality/terminal; model never writes world truth
- Match orchestrator: `engines/ts/src/chess-match.ts` (shared `ChessWorld`, per-turn FaustRuntime)

### 2.2 Study matrix (`manifest.yml`)

| Condition | Role |
|-----------|------|
| `legality-gated` | Primary wind tunnel (series) |
| `permissive-control` | Control — no sequence gates; measures raw illegal proposals |
| `oriented` | Gated + orientation frame each step |

Track A fixtures (`conformance/fixtures/chess-*`) already validated gates offline (see `results/PROCEDURAL-RELIABILITY.md`).

### 2.3 Legality-gated agent (series surface)

Path: `case-studies/chess/harnesses/legality-gated/agent.yml`

**State (canonical, harness-owned):**

| Field | Role |
|-------|------|
| `fen` | Start / current FEN mirror |
| `observed` | 1 after successful `board.observe` |
| `moves_played` | Successful legal moves |
| `illegal_attempts` | Counter of illegal UCI proposals |
| `game_over` | Terminal flag from world |

**Limits (agent YAML):** `max_steps: 24`, `max_tool_calls: 20`, `continue_after_deny: true`  
**Match turn override:** orchestrator clones agent per ply with ~12 step/tool budget.

**Tools:**

| Tool | Contract |
|------|----------|
| `board.observe` | Read-only. Returns `fen`, `side`, `legal_moves` (UCI sorted), `position_hash`, check/material/terminal. Sets `observed=1`. |
| `board.move` | Args: `move` (UCI), optional `position_hash`. Outputs `ok` / `illegal` / `stale`. **Verify:** deny if `illegal≠0` or `stale≠0`. Legal move mutates board and clears `observed`. |
| `game.claim` | `kind` ∈ checkmate \| draw \| stalemate. Used for terminal claims; series rarely invoked it (orchestrator ends on chess.js terminal). |

**Gates / sequences:**

```
counterbalance.sequences:
  observe-before-move  →  board.move requires prior board.observe

gates:
  observe-before-claim → game.claim requires state.observed == 1
```

**Permissions:** only `board.observe`, `board.move`, `game.claim`.

### 2.4 Deployment bindings (KIT live)

Path: `case-studies/chess/deployments/kit.yml`

```yaml
bindings:
  board.observe: { native: stub.board_observe }
  board.move:    { native: stub.board_move }
  game.claim:    { native: stub.game_claim }
```

Natives resolve to the chess adapter (`createChessTools`). Transport: openai-compatible → `https://ki-toolbox.scc.kit.edu/api/v1`, `KIT_AI_API_KEY`.

### 2.5 Match orchestration (how two models share one board)

```
┌─────────────────────────────────────────────────────────┐
│  chess-match.ts                                         │
│  shared ChessWorld (chess.js)                           │
│                                                         │
│  for game in 1..N:                                      │
│    odd  → A White, B Black                              │
│    even → B White, A Black   ← color switch (required)  │
│    for ply until terminal | abort | max_plies:          │
│      adapter = side-to-move model                       │
│      FaustRuntime(legality-gated) until legal move      │
│      stop turn after ok=1 board.move                    │
│    write games/game-NN.json + traces/game-NN.jsonl      │
└─────────────────────────────────────────────────────────┘
```

**End conditions:**

| `ended_by` | Meaning |
|------------|---------|
| `terminal` | chess.js: checkmate / stalemate / repetition / insufficient / draw |
| `abort` | Side to move failed to produce a legal `board.move` this turn |
| `ply_cap` | Hit `--max-plies` (200) without chess terminal |

Abort is **not** resign. Typical causes: provider error, or `empty_proposal` / illegal thrash until turn budget expires (`no_legal_move`).

### 2.6 Terminal detection (world)

From `terminalStatus()` in the chess adapter (chess.js):

- checkmate  
- stalemate (Patt)  
- threefold repetition  
- insufficient material  
- fifty-move / other draw  

Wired and checked after every successful move; **never fired** in this series.

### 2.7 Control harnesses (not used in live series)

| Harness | Difference vs gated |
|---------|---------------------|
| `permissive-control` | No observe→move sequence; no illegal/stale verify on move (illegal still `ok:0`, no mutation) |
| `oriented` | Same gates as legality-gated + orientation emit each step |

---

## 3. Series configuration

| Parameter | Value |
|-----------|--------|
| Model A | `kit.minimax-m2.7-229b` |
| Model B | `kit.mistral-small-4-119b-a8b` |
| Color policy | Alternate each game (odd: A White; even: B White) |
| Max plies | 200 |
| Harness | `legality-gated` |
| Deployment | `case-studies/chess/deployments/kit.yml` |
| Artifacts | `live/reports/chess-series/{summary.json,games/,traces/,run.log}` |

---

## 4. Results

### 4.1 Outcome mix

| Kind | Games | Notes |
|------|------:|-------|
| Infra outage | 10 | KIT: minimax temporarily unavailable |
| Protocol fail | 5 | All on **minimax** turns (`no_legal_move` / empty tool call) |
| Ply cap | 1 | G12 — 200 moves, still `ongoing` |
| Chess terminal | 0 | — |

Color balance among completed games: A as White **8**, A as Black **8**.

### 4.2 Per-game ledger

| G | End | Moves | Illegal | White | Black | Failed side | Note |
|--:|-----|------:|--------:|-------|-------|-------------|------|
| 1 | infra | 0 | 0 | minimax | mistral | minimax | unavailable |
| 2 | infra | 1 | 0 | mistral | minimax | minimax | e4 then unavailable |
| 3 | infra | 0 | 0 | minimax | mistral | minimax | unavailable |
| 4 | infra | 1 | 0 | mistral | minimax | minimax | e4 then unavailable |
| 5 | infra | 0 | 0 | minimax | mistral | minimax | unavailable |
| 6 | infra | 1 | 0 | mistral | minimax | minimax | e4 then unavailable |
| 7 | infra | 0 | 0 | minimax | mistral | minimax | unavailable |
| 8 | infra | 1 | 0 | mistral | minimax | minimax | e4 then unavailable |
| 9 | infra | 0 | 0 | minimax | mistral | minimax | unavailable |
| 10 | infra | 1 | 0 | mistral | minimax | minimax | e4 then unavailable |
| 11 | protocol | 160 | 6 | minimax | mistral | minimax | empty_proposal thrash |
| 12 | ply_cap | 200 | 12 | mistral | minimax | — | only full-length game |
| 13 | protocol | 14 | 0 | minimax | mistral | minimax | empty_proposal |
| 14 | protocol | 161 | 7 | mistral | minimax | minimax | no_legal_move (Black) |
| 15 | protocol | 12 | 0 | minimax | mistral | minimax | empty_proposal |
| 16 | protocol | 89 | 6 | mistral | minimax | minimax | illegal then empty_proposal |

Opening when a first move landed: **e4** (11/11).

### 4.3 Model comparison (procedural)

On substantive games (≥2 moves; ~322 minimax turns vs ~319 mistral):

| | minimax | mistral |
|--|--------:|--------:|
| Protocol aborts caused | 5 | 0 |
| Illegal-attempt deltas | 29 | 2 |
| Gate denies (authorize) | 0 | 0 |
| Verify fails on move | 29 | 2 |

Interpretation: under the same harness, **mistral** stayed on the tool path; **minimax** more often returned long reasoning without a tool call (`empty_proposal`) or proposed illegal UCI that verify denied. Board integrity preserved in both cases.

### 4.4 What the harness proved in live play

- Illegal UCI → `illegal: 1` + verify deny → **no mutation**
- Stale hash path unchanged from Track A design (available; not the dominant abort mode here)
- Observe-before-move sequence still required each turn
- Shared `ChessWorld` + color alternation worked as designed
- Terminal detectors ready but unused (no mate/Patt/repetition reached)

### 4.5 What this series does *not* claim

- Playing strength / ELO
- Fair head-to-head wins (zero terminals; heavy infra skew against minimax availability)
- That 20/20 completed (stopped at 16)
- That abort = intentional resign

---

## 5. Artifacts & provenance

| Path | Contents |
|------|----------|
| `live/reports/chess-series/summary.json` | Series totals (updated per game) |
| `live/reports/chess-series/games/game-NN.json` | Per-game report + turn events |
| `live/reports/chess-series/traces/game-NN.jsonl` | Event-level traces |
| `live/reports/chess-series/run.log` | Live board / ply stream |
| `engines/ts/src/adapters/chess.ts` | World adapter |
| `engines/ts/src/chess-match.ts` | Two-model orchestrator |
| `case-studies/chess/harnesses/legality-gated/` | Series harness |
| `case-studies/chess/results/PROCEDURAL-RELIABILITY.md` | Track A gate report |

---

## 6. Recommendations (next run)

1. **Infra:** retry/backoff on `ServiceUnavailable`; or pick two currently healthy KIT models for the full matrix.  
2. **Protocol:** on `empty_proposal`, stronger tool nudge / shorter think budget / fail-fast after one empty with explicit “call board.move” user message.  
3. **Analysis cut:** report strength only on games with `ended_by: terminal` or ply ≥ N without protocol abort.  
4. **Optional:** engine-bounded `board.candidates` shortlist (ADAPTER extension) to reduce illegal UCI noise.

---

## 7. Relation to Track A

Track A fixtures (`PROCEDURAL-RELIABILITY.md`) already **PASS** for legality, stale, observe-before-move, and claim gates on recorded proposals. This live series is the first multi-model soak: gates still hold; **host/model reliability** and **tool adherence** dominate end-of-game labels.
