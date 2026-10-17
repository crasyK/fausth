// The browser host (build plan step 12): the TypeScript engine in one HTML page. It replays the
// conformance fixtures, and it plays a harness live with chess.js tools and an OpenAI-compatible
// endpoint that allows browser calls. The API key stays in this page's memory.
import { InfraFailure, run, type Answer, type Host } from "../../../engines/ts/src/engine.js";
import { harnessErrors, readHarness, type Harness } from "../../../engines/ts/src/harness.js";
import type { Entry } from "../../../engines/ts/src/log.js";
import { ChatModel } from "../../../engines/ts/src/openai.js";
import { replayFiles, type FixtureFiles } from "../../../engines/ts/src/replay.js";
import { canonical, type Json } from "../../../engines/ts/src/values.js";
import fixtures from "embedded:fixtures";
import chessHarness from "embedded:chess-harness";
import { chessTools } from "./chess-tools.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function cell(row: HTMLTableRowElement, text: string, cls = ""): void {
  const td = row.insertCell();
  td.textContent = text;
  if (cls) td.className = cls;
}

/** Replay every embedded fixture with the TS engine and compare with its expected files. */
async function replayAll(): Promise<void> {
  const body = $<HTMLTableSectionElement>("replay-rows");
  body.replaceChildren();
  let matching = 0;
  const names = Object.keys(fixtures).sort();
  for (const name of names) {
    const f = fixtures[name]!;
    const row = body.insertRow();
    cell(row, name);
    try {
      const out = await replayFiles(f);
      const ok = out.log === f.expected_log && out.requests === f.expected_requests;
      if (ok) matching += 1;
      cell(row, out.log === f.expected_log ? "match" : "DIFFERS", out.log === f.expected_log ? "ok" : "bad");
      cell(row, out.requests === f.expected_requests ? "match" : "DIFFERS", out.requests === f.expected_requests ? "ok" : "bad");
      cell(row, (await sha256(out.log)).slice(0, 12), "hash");
      cell(row, (await sha256(out.requests)).slice(0, 12), "hash");
    } catch (e) {
      cell(row, `error: ${e instanceof Error ? e.message : String(e)}`, "bad");
    }
  }
  $("replay-summary").textContent = `${matching}/${names.length} fixtures replay to their expected files byte for byte.`;
  $("replay-summary").className = matching === names.length ? "ok" : "bad";
}

function describe(e: Entry): string {
  const depth = "  ".repeat(Number(e.depth ?? 0));
  const short = (v: unknown, n = 160) => { const s = typeof v === "string" ? v : canonical(v); return s.length > n ? `${s.slice(0, n)}…` : s; };
  switch (e.type) {
    case "assistant": {
      const calls = (e.tool_calls as { tool: string; args: Json }[]).map((c) => `${c.tool} ${short(c.args, 120)}`);
      return `${depth}${e.seq} assistant (step ${e.step})${e.text ? `: ${short(e.text)}` : ""}${calls.length ? ` → ${calls.join("; ")}` : ""}`;
    }
    case "tool_result": return `${depth}${e.seq} ${e.tool} ${e.ok ? "→" : "failed:"} ${short(e.ok ? e.result : e.error)}`;
    case "hook": return `${depth}${e.seq} hook ${e.hook} (${e.event}): ${e.decision}${e.text !== undefined ? ` "${short(e.text)}"` : ""}`;
    case "run_end": return `${depth}${e.seq} run_end: ${e.reason}`;
    default: return `${depth}${e.seq} ${e.type}${e.text !== undefined ? `: ${short(e.text)}` : ""}`;
  }
}

/** Play the harness in the text area live: chess.js tools, the endpoint's model, one user message. */
async function play(): Promise<void> {
  const status = $("play-status");
  const show = (text: string, cls = "") => { status.textContent = text; status.className = cls; };
  const logView = $("play-log");
  logView.textContent = "";
  let harness: Harness;
  try {
    const value = readHarness($<HTMLTextAreaElement>("harness").value);
    const errors = harnessErrors(value);
    if (errors.length > 0) return show(`invalid harness: ${errors.join("; ")}`, "bad");
    harness = value as unknown as Harness;
  } catch (e) {
    return show(`invalid harness: ${e instanceof Error ? e.message : String(e)}`, "bad");
  }
  const tools = chessTools($<HTMLInputElement>("fen").value.trim() || undefined);
  const bindings: Record<string, (args: Json) => Promise<Answer>> = {
    board_observe: () => tools.board_observe(),
    board_legal_moves: () => tools.board_legal_moves(),
    board_move: (args) => tools.board_move(args as { [k: string]: unknown }),
  };
  const declared = [...Object.keys(harness.tools ?? {}), ...Object.keys(harness.handlers ?? {})].filter((id) => id !== "core_spawn");
  const unbound = declared.filter((id) => !Object.hasOwn(bindings, id));
  if (unbound.length > 0) return show(`this page binds only the chess tools; unbound: ${unbound.join(", ")}`, "bad");

  const key = $<HTMLInputElement>("key").value.trim();
  if (!key) return show("paste an API key first", "bad");
  const model = new ChatModel($<HTMLInputElement>("base").value.trim(), key, $<HTMLInputElement>("model").value.trim(),
    $<HTMLInputElement>("provider").value.trim() || "openai-compatible", { timeoutMs: 120_000 });
  const board = $("board");
  board.textContent = tools.game.ascii();
  const messages = [$<HTMLInputElement>("user").value];
  let failure = "";
  let requests = 0;
  const host: Host = {
    async user() {
      return messages.shift() ?? null;
    },
    async model(request) {
      requests += 1;
      show(`request ${requests}: waiting for the model…`);
      try {
        return await model.call(request);
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
    async call(id, input) {
      const binding = bindings[id];
      if (!binding) throw new InfraFailure(`${id} is not bound`);
      const answer = await binding(input);
      board.textContent = tools.game.ascii();
      return answer;
    },
    interrupts: () => [],
  };
  $<HTMLButtonElement>("run").disabled = true;
  try {
    const log = await run(harness, host);
    logView.textContent = log.entries.map(describe).join("\n");
    const reason = log.entries.at(-1)!.reason as string;
    show(`run_end: ${reason}${failure ? ` (${failure})` : ""}; ${requests} model requests; position: ${tools.game.fen()}`,
      reason === "stop" ? "ok" : "bad");
    ($("download") as HTMLAnchorElement).href = URL.createObjectURL(new Blob([log.text()], { type: "application/jsonl" }));
    $("download").hidden = false;
  } finally {
    $<HTMLButtonElement>("run").disabled = false;
  }
}

$<HTMLTextAreaElement>("harness").value = chessHarness;
$("replay").addEventListener("click", () => void replayAll());
$("run").addEventListener("click", () => void play());
if (location.hash === "#replay") void replayAll();

export type { FixtureFiles };
