/**
 * Two-model chess series over a shared ChessWorld per game.
 * Plays each game to terminal (or abort / ply cap). Alternates colors every game.
 * Persists full Faust event traces per turn.
 *
 * Usage:
 *   node --import tsx src/chess-match.ts \
 *     --deployment ../../case-studies/chess/deployments/kit.yml \
 *     --model-a kit.minimax-m2.7-229b \
 *     --model-b kit.mistral-small-4-119b-a8b \
 *     --games 20 \
 *     --max-plies 200 \
 *     --out-dir ../../live/reports/chess-series
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  START_FEN,
  chessWorldFromAgent,
  createChessTools,
  formatAsciiBoard,
  legalMovesUci,
  materialSummary,
  terminalStatus,
  type ChessWorld,
} from "./adapters/chess.js";
import { createConversationalPropose } from "./integrations/github/conversational-propose.js";
import { loadAgentDir, loadDeployment } from "./load.js";
import { createAdapterFromDeployment, toolsFromAgent } from "./model/index.js";
import type { ModelPort, ModelProposal as PortProposal } from "./model/port.js";
import { FaustRuntime, type ToolHandler } from "./runtime.js";
import type { AgentIR, Deployment, Event, ModelProposal, ToolResultEnvelope } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

const RULE = "────────────────────────────────────────────────────────";
const DRULE = "════════════════════════════════════════════════════════";

function shortModel(id: string): string {
  const bare = id.replace(/^kit\./, "").replace(/^openrouter\./, "");
  return bare.length > 36 ? `${bare.slice(0, 33)}...` : bare;
}

function colorLabel(color: "w" | "b"): string {
  return color === "w" ? "White" : "Black";
}

function printBoardState(
  world: ChessWorld,
  opts?: { lastSan?: string; lastUci?: string; lastModel?: string },
): void {
  const mat = materialSummary(world.chess);
  const side = world.chess.turn() as "w" | "b";
  const term = terminalStatus(world.chess);
  const check = world.chess.inCheck() ? "  in check" : "";
  const last =
    opts?.lastSan && opts?.lastUci
      ? `  last: ${opts.lastSan} (${opts.lastUci})${opts.lastModel ? ` · ${shortModel(opts.lastModel)}` : ""}`
      : "";
  // Prefer color when stdout is a TTY; force with FAUSTH_CHESS_COLOR=1 (even under tee).
  const colorEnv = process.env.FAUSTH_CHESS_COLOR;
  const useColor =
    colorEnv === "0" || colorEnv === "false"
      ? false
      : colorEnv === "1" || colorEnv === "true"
        ? true
        : Boolean(process.stdout.isTTY);
  console.log(formatAsciiBoard(world.chess, { lastUci: opts?.lastUci, color: useColor }));
  console.log(
    `  side: ${colorLabel(side)}${check}  |  material W${mat.white}–B${mat.black}` +
      `  |  moves: ${world.moves_played}  |  illegal: ${world.illegal_attempts}` +
      (term.game_over === 1 ? `  |  ${term.result}` : ""),
  );
  if (last) console.log(last);
}

function repoRoot(): string {
  return resolve(join(here, "../../.."));
}

function loadDotEnv(path = join(repoRoot(), ".env")): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

function toRuntimeProposal(p: PortProposal): ModelProposal {
  if (p.type === "tool") return { type: "tool", name: p.name, args: p.args };
  if (p.type === "stop") return { type: "stop", message: p.message };
  if (p.type === "invalid") {
    return {
      type: "invalid",
      reason: p.reason,
      message: p.raw ?? p.reason,
    };
  }
  return { type: "invalid", reason: "empty_proposal", message: "" };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "1";
    }
  }
  return out;
}

function cloneAgentForTurn(base: AgentIR, world: ChessWorld, color: "w" | "b"): AgentIR {
  const fen = world.chess.fen();
  const agent = structuredClone(base) as AgentIR;
  agent.name = color === "w" ? "chess-white" : "chess-black";
  agent.state = {
    ...agent.state,
    fen,
    observed: 0,
    moves_played: world.moves_played,
    illegal_attempts: world.illegal_attempts,
    game_over: terminalStatus(world.chess).game_over,
    side: world.chess.turn(),
  };
  agent.limits = {
    ...agent.limits,
    max_steps: 12,
    max_tool_calls: 12,
    continue_after_deny: true,
  };
  return agent;
}

function wrapToolsStopAfterMove(
  tools: Record<string, ToolHandler>,
  onLegalMove: () => void,
): Record<string, ToolHandler> {
  const move = tools["board.move"];
  if (!move) return tools;
  return {
    ...tools,
    "board.move": async (args, ctx): Promise<ToolResultEnvelope> => {
      const envelope = await move(args, ctx);
      const out = envelope.output as Record<string, unknown>;
      if (Number(out.ok) === 1) onLegalMove();
      return envelope;
    },
  };
}

function successfulMove(events: Event[]): { move: string; san: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.tool !== "board.move" || e.stage !== "execute" || e.verdict !== "allow") continue;
    const r = e.result as Record<string, unknown> | undefined;
    if (r && Number(r.ok) === 1) {
      return { move: String(r.move ?? ""), san: String(r.san ?? "") };
    }
  }
  return null;
}

type TurnResult = {
  ply: number;
  color: "w" | "b";
  model: string;
  ok: boolean;
  move?: string;
  san?: string;
  fen_before: string;
  fen_after?: string;
  illegal_attempts_delta: number;
  steps: number;
  gate_denies: number;
  verify_failures: number;
  error?: string;
  /** Full FaustRuntime event trace for this turn. */
  events: Event[];
};

type GameReport = {
  game_id: number;
  started_at: string;
  finished_at: string;
  /** Color assignment for this game (swaps every game). */
  white: string;
  black: string;
  model_a_color: "w" | "b";
  model_b_color: "w" | "b";
  moves: string[];
  sans: string[];
  moves_played: number;
  illegal_attempts: number;
  fen: string;
  result: string;
  game_over: 0 | 1;
  ended_by: "terminal" | "abort" | "ply_cap";
  valid_play: boolean;
  winner_model: string | null;
  turns: TurnResult[];
};

type SeriesSummary = {
  started_at: string;
  finished_at: string;
  deployment: string;
  model_a: string;
  model_b: string;
  games_requested: number;
  games_completed: number;
  max_plies: number;
  color_policy: "alternate_each_game";
  totals: {
    terminal: number;
    abort: number;
    ply_cap: number;
    valid_play: number;
    illegal_attempts: number;
    moves_played: number;
    model_a_wins: number;
    model_b_wins: number;
    draws: number;
    model_a_as_white: number;
    model_a_as_black: number;
  };
  games: Array<{
    game_id: number;
    white: string;
    black: string;
    result: string;
    ended_by: string;
    moves_played: number;
    illegal_attempts: number;
    valid_play: boolean;
    winner_model: string | null;
    trace: string;
  }>;
};

async function playTurn(opts: {
  baseAgent: AgentIR;
  world: ChessWorld;
  adapter: ModelPort & { lastModelUsed: string };
  color: "w" | "b";
  ply: number;
}): Promise<TurnResult> {
  const fenBefore = opts.world.chess.fen();
  const illegalBefore = opts.world.illegal_attempts;
  const agent = cloneAgentForTurn(opts.baseAgent, opts.world, opts.color);
  const colorName = opts.color === "w" ? "White" : "Black";

  let legalMoveDone = false;
  const tools = wrapToolsStopAfterMove(createChessTools(opts.world), () => {
    legalMoveDone = true;
  });

  let runtime!: FaustRuntime;
  const propose = createConversationalPropose({
    adapter: opts.adapter,
    tools: toolsFromAgent(agent.tools),
    system: [
      `You are playing chess as ${colorName}.`,
      "Board truth is owned by the tools — never invent FEN or legality.",
      "Protocol each turn:",
      "1) Call board.observe.",
      "2) Pick one UCI move from legal_moves (e.g. e2e4, e7e8q).",
      "3) Call board.move with that move and the position_hash from observe.",
      "After a successful move (ok=1), stop. Do not move again.",
      "If a move is denied as illegal or stale, observe again and retry with a legal move.",
    ].join(" "),
    user: `Ply ${opts.ply}: it is ${colorName}'s turn. Observe, then play exactly one legal move.`,
    getRuntime: () => runtime,
  });

  const innerPropose = async (): Promise<ModelProposal> => {
    if (legalMoveDone) return { type: "stop", message: "legal move complete" };
    return toRuntimeProposal(await propose());
  };

  runtime = new FaustRuntime({
    agent,
    propose: innerPropose,
    tools,
    allowJudge: false,
  });

  const baseMeta = {
    ply: opts.ply,
    color: opts.color,
    fen_before: fenBefore,
  };

  try {
    await runtime.runLoop(12);
  } catch (e) {
    return {
      ...baseMeta,
      model: opts.adapter.lastModelUsed,
      ok: false,
      illegal_attempts_delta: opts.world.illegal_attempts - illegalBefore,
      steps: runtime.events.length,
      gate_denies: 0,
      verify_failures: 0,
      error: e instanceof Error ? e.message : String(e),
      events: runtime.events,
    };
  }

  const gateDenies = runtime.events.filter(
    (e) =>
      e.verdict === "deny" &&
      (e.reason === "gate_denied" ||
        e.reason === "sequence_requirement_failed" ||
        e.reason === "capability_missing"),
  ).length;
  const verifyFails = runtime.events.filter((e) => e.reason?.startsWith("verify_")).length;
  const hit = successfulMove(runtime.events);

  if (!hit) {
    return {
      ...baseMeta,
      model: opts.adapter.lastModelUsed,
      ok: false,
      illegal_attempts_delta: opts.world.illegal_attempts - illegalBefore,
      steps: runtime.events.length,
      gate_denies: gateDenies,
      verify_failures: verifyFails,
      error: "no_legal_move",
      fen_after: opts.world.chess.fen(),
      events: runtime.events,
    };
  }

  return {
    ...baseMeta,
    model: opts.adapter.lastModelUsed,
    ok: true,
    move: hit.move,
    san: hit.san,
    fen_after: opts.world.chess.fen(),
    illegal_attempts_delta: opts.world.illegal_attempts - illegalBefore,
    steps: runtime.events.length,
    gate_denies: gateDenies,
    verify_failures: verifyFails,
    events: runtime.events,
  };
}

function withSingleModel(deployment: Deployment, modelId: string): Deployment {
  return {
    ...deployment,
    model: {
      ...deployment.model,
      models: [modelId],
    },
  };
}

function winnerModel(
  result: string,
  white: string,
  black: string,
): string | null {
  if (result === "checkmate") {
    // Side to move lost — after terminal, turn is the side that cannot move.
    // chess.js: isCheckmate means side to move is checkmated, so the other color won.
    // We pass fen's turn via terminalStatus — better compute from white/black + last move color.
    return null; // filled by caller with last mover
  }
  if (result === "ongoing") return null;
  return null; // draws
}

async function playGame(opts: {
  gameId: number;
  baseAgent: AgentIR;
  deployment: Deployment;
  whiteModel: string;
  blackModel: string;
  modelA: string;
  modelB: string;
  maxPlies: number;
  checkpointDir?: string;
}): Promise<GameReport> {
  const startedAt = new Date().toISOString();
  const world = chessWorldFromAgent({
    ...opts.baseAgent,
    state: {
      ...opts.baseAgent.state,
      fen: START_FEN,
      observed: 0,
      moves_played: 0,
      illegal_attempts: 0,
      game_over: 0,
    },
  });

  const white = createAdapterFromDeployment(withSingleModel(opts.deployment, opts.whiteModel));
  const black = createAdapterFromDeployment(withSingleModel(opts.deployment, opts.blackModel));

  const turns: TurnResult[] = [];
  const moveList: string[] = [];
  const sanList: string[] = [];
  let endedBy: GameReport["ended_by"] = "ply_cap";

  console.log(`\n${DRULE}`);
  console.log(`  GAME ${opts.gameId}`);
  console.log(`  White  ${opts.whiteModel}`);
  console.log(`  Black  ${opts.blackModel}`);
  console.log(DRULE);
  printBoardState(world);

  for (let ply = 1; ply <= opts.maxPlies; ply++) {
    const term = terminalStatus(world.chess);
    if (term.game_over === 1) {
      endedBy = "terminal";
      console.log(`\n${RULE}`);
      console.log(`  Terminal before ply ${ply}: ${term.result}`);
      console.log(RULE);
      break;
    }

    const color = world.chess.turn() as "w" | "b";
    const adapter = color === "w" ? white.adapter : black.adapter;
    const modelId = color === "w" ? opts.whiteModel : opts.blackModel;
    const legal = legalMovesUci(world.chess);
    const mat = materialSummary(world.chess);
    console.log(`\n${RULE}`);
    console.log(
      `  Ply ${ply}  ·  ${colorLabel(color)}  ·  ${shortModel(modelId)}`,
    );
    console.log(
      `  legal: ${legal.length}  |  material W${mat.white}–B${mat.black}` +
        `  |  illegal: ${world.illegal_attempts}`,
    );
    process.stdout.write(`  thinking ... `);

    const turn = await playTurn({
      baseAgent: opts.baseAgent,
      world,
      adapter,
      color,
      ply,
    });
    turns.push(turn);

    if (!turn.ok) {
      endedBy = "abort";
      console.log(`ABORT`);
      console.log(
        `  reason: ${turn.error}  |  illegalΔ=${turn.illegal_attempts_delta}` +
          `  |  denies=${turn.gate_denies}  |  verify_fail=${turn.verify_failures}`,
      );
      printBoardState(world);
      break;
    }

    moveList.push(turn.move!);
    sanList.push(turn.san!);
    console.log(`OK  ${turn.san} (${turn.move})`);
    printBoardState(world, {
      lastSan: turn.san,
      lastUci: turn.move,
      lastModel: modelId,
    });

    const after = terminalStatus(world.chess);
    if (after.game_over === 1) {
      endedBy = "terminal";
      console.log(`\n${DRULE}`);
      console.log(`  RESULT  ${after.result.toUpperCase()}`);
      if (after.result === "checkmate") {
        console.log(`  Winner  ${shortModel(modelId)} (${colorLabel(color)})`);
      }
      console.log(DRULE);
      break;
    }

    // Mid-game checkpoint every 10 plies (survives long games / crashes).
    if (opts.checkpointDir && ply % 10 === 0) {
      const partial: Partial<GameReport> & { checkpoint_ply: number; status: "in_progress" } = {
        status: "in_progress",
        checkpoint_ply: ply,
        game_id: opts.gameId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        white: opts.whiteModel,
        black: opts.blackModel,
        model_a_color: opts.whiteModel === opts.modelA ? "w" : "b",
        model_b_color: opts.whiteModel === opts.modelB ? "w" : "b",
        moves: [...moveList],
        sans: [...sanList],
        moves_played: world.moves_played,
        illegal_attempts: world.illegal_attempts,
        fen: world.chess.fen(),
        result: after.result,
        game_over: after.game_over,
        ended_by: "ply_cap",
        valid_play: false,
        winner_model: null,
        turns,
      };
      writeJson(
        join(opts.checkpointDir, `game-${String(opts.gameId).padStart(2, "0")}.partial.json`),
        partial,
      );
    }
  }

  const term = terminalStatus(world.chess);
  if (endedBy === "ply_cap" && term.game_over === 1) endedBy = "terminal";

  if (endedBy === "ply_cap" || endedBy === "abort") {
    console.log(`\n${DRULE}`);
    console.log(`  RESULT  ${endedBy.toUpperCase()} / ${term.result}`);
    console.log(
      `  moves=${world.moves_played}  illegal=${world.illegal_attempts}`,
    );
    console.log(DRULE);
  }

  const legalMovesPlayed = moveList.length;
  const validPlay =
    legalMovesPlayed === world.moves_played &&
    turns.filter((t) => t.ok).length === legalMovesPlayed &&
    (endedBy === "terminal" || endedBy === "ply_cap" || endedBy === "abort");

  let winner: string | null = null;
  if (endedBy === "terminal" && term.result === "checkmate" && turns.length > 0) {
    const last = [...turns].reverse().find((t) => t.ok);
    winner = last?.model ?? null;
  }

  void winnerModel; // reserved

  return {
    game_id: opts.gameId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    white: opts.whiteModel,
    black: opts.blackModel,
    model_a_color: opts.whiteModel === opts.modelA ? "w" : "b",
    model_b_color: opts.whiteModel === opts.modelB ? "w" : "b",
    moves: moveList,
    sans: sanList,
    moves_played: world.moves_played,
    illegal_attempts: world.illegal_attempts,
    fen: world.chess.fen(),
    result: term.result,
    game_over: term.game_over,
    ended_by: endedBy,
    valid_play: validPlay && endedBy !== "abort" ? legalMovesPlayed > 0 : endedBy === "abort" ? false : validPlay,
    winner_model: winner,
    turns,
  };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function writeTraceJsonl(path: string, game: GameReport): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "game_meta",
      game_id: game.game_id,
      white: game.white,
      black: game.black,
      model_a_color: game.model_a_color,
      model_b_color: game.model_b_color,
      started_at: game.started_at,
      finished_at: game.finished_at,
    }),
  );
  for (const turn of game.turns) {
    lines.push(
      JSON.stringify({
        type: "turn",
        game_id: game.game_id,
        ply: turn.ply,
        color: turn.color,
        model: turn.model,
        ok: turn.ok,
        move: turn.move ?? null,
        san: turn.san ?? null,
        fen_before: turn.fen_before,
        fen_after: turn.fen_after ?? null,
        illegal_attempts_delta: turn.illegal_attempts_delta,
        error: turn.error ?? null,
      }),
    );
    for (const ev of turn.events) {
      lines.push(
        JSON.stringify({
          type: "event",
          game_id: game.game_id,
          ply: turn.ply,
          color: turn.color,
          model: turn.model,
          ...ev,
        }),
      );
    }
  }
  lines.push(
    JSON.stringify({
      type: "game_end",
      game_id: game.game_id,
      result: game.result,
      ended_by: game.ended_by,
      moves: game.moves,
      sans: game.sans,
      fen: game.fen,
      winner_model: game.winner_model,
      illegal_attempts: game.illegal_attempts,
      valid_play: game.valid_play,
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const depPath = resolve(
    args.deployment ?? join(repoRoot(), "case-studies/chess/deployments/kit.yml"),
  );
  const agentDir = resolve(
    args.agent ?? join(repoRoot(), "case-studies/chess/harnesses/legality-gated"),
  );
  const maxPlies = Number(args["max-plies"] ?? 200);
  const gamesN = Math.max(1, Number(args.games ?? 20));
  const outDir = resolve(
    args["out-dir"] ?? args.out ?? join(repoRoot(), "live/reports/chess-series"),
  );

  const deployment = loadDeployment(depPath) as Deployment;
  const models = deployment.model.models ?? [];
  // Prefer model-a/model-b; fall back to --white/--black as the pair (then swap).
  const modelA = args["model-a"] ?? args.white ?? models[0];
  const modelB = args["model-b"] ?? args.black ?? models[1] ?? models[0];
  if (!modelA || !modelB) {
    console.error("Need --model-a and --model-b (or deployment with ≥2 models)");
    return 2;
  }
  if (modelA === modelB) {
    console.error("model-a and model-b must differ so color switching is meaningful");
    return 2;
  }

  const { agent: baseAgent } = loadAgentDir(agentDir);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "games"), { recursive: true });
  mkdirSync(join(outDir, "traces"), { recursive: true });

  const seriesStarted = new Date().toISOString();
  const gameSummaries: SeriesSummary["games"] = [];
  let modelAWins = 0;
  let modelBWins = 0;
  let draws = 0;
  let terminal = 0;
  let abort = 0;
  let plyCap = 0;
  let validPlay = 0;
  let illegalAttempts = 0;
  let movesPlayed = 0;
  let modelAAsWhite = 0;
  let modelAAsBlack = 0;

  console.log(DRULE);
  console.log(`  Chess series  ·  ${gamesN} games to terminal  ·  max_plies=${maxPlies}`);
  console.log(`  model_a  ${modelA}`);
  console.log(`  model_b  ${modelB}`);
  console.log(`  color_policy  alternate each game (odd: A White; even: B White)`);
  console.log(`  out_dir  ${outDir}`);
  console.log(DRULE);

  for (let g = 1; g <= gamesN; g++) {
    // CRITICAL: switch colors every game.
    // Game 1,3,5,... → A White / B Black
    // Game 2,4,6,... → B White / A Black
    const aIsWhite = g % 2 === 1;
    const whiteModel = aIsWhite ? modelA : modelB;
    const blackModel = aIsWhite ? modelB : modelA;
    if (aIsWhite) modelAAsWhite++;
    else modelAAsBlack++;

    const game = await playGame({
      gameId: g,
      baseAgent,
      deployment,
      whiteModel,
      blackModel,
      modelA,
      modelB,
      maxPlies,
      checkpointDir: join(outDir, "games"),
    });

    const gamePath = join(outDir, "games", `game-${String(g).padStart(2, "0")}.json`);
    const tracePath = join(outDir, "traces", `game-${String(g).padStart(2, "0")}.jsonl`);
    writeJson(gamePath, game);
    writeTraceJsonl(tracePath, game);

    gameSummaries.push({
      game_id: g,
      white: game.white,
      black: game.black,
      result: game.result,
      ended_by: game.ended_by,
      moves_played: game.moves_played,
      illegal_attempts: game.illegal_attempts,
      valid_play: game.valid_play,
      winner_model: game.winner_model,
      trace: tracePath,
    });

    if (game.ended_by === "terminal") terminal++;
    else if (game.ended_by === "abort") abort++;
    else plyCap++;
    if (game.valid_play) validPlay++;
    illegalAttempts += game.illegal_attempts;
    movesPlayed += game.moves_played;

    if (game.winner_model === modelA) modelAWins++;
    else if (game.winner_model === modelB) modelBWins++;
    else if (game.ended_by === "terminal" && game.result !== "checkmate") draws++;

    // Incremental summary so a long run is inspectable mid-flight.
    const summary: SeriesSummary = {
      started_at: seriesStarted,
      finished_at: new Date().toISOString(),
      deployment: depPath,
      model_a: modelA,
      model_b: modelB,
      games_requested: gamesN,
      games_completed: g,
      max_plies: maxPlies,
      color_policy: "alternate_each_game",
      totals: {
        terminal,
        abort,
        ply_cap: plyCap,
        valid_play: validPlay,
        illegal_attempts: illegalAttempts,
        moves_played: movesPlayed,
        model_a_wins: modelAWins,
        model_b_wins: modelBWins,
        draws,
        model_a_as_white: modelAAsWhite,
        model_a_as_black: modelAAsBlack,
      },
      games: gameSummaries,
    };
    writeJson(join(outDir, "summary.json"), summary);

    console.log(`\n${RULE}`);
    console.log(
      `  Game ${g}/${gamesN} done  ·  ${game.ended_by}/${game.result}` +
        `  ·  moves=${game.moves_played}  ·  A_color=${game.model_a_color}` +
        `  ·  winner=${game.winner_model ? shortModel(game.winner_model) : "-"}`,
    );
    console.log(RULE);
  }

  const finalSummary = JSON.parse(
    readFileSync(join(outDir, "summary.json"), "utf8"),
  ) as SeriesSummary;
  console.log(`\n${DRULE}`);
  console.log(`  SERIES COMPLETE`);
  console.log(DRULE);
  console.log(JSON.stringify(finalSummary.totals, null, 2));
  console.log(`summary: ${join(outDir, "summary.json")}`);

  // Exit 0 if we completed the requested games count (even with aborts — those are measured).
  return finalSummary.games_completed >= gamesN ? 0 : 1;
}

main().then((code) => process.exit(code));
