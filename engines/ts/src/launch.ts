// A binding that launches another Fausth run (spec §13.1): the harness it is handed, with its own log and limits.
//
// A handler bound this way takes the harness from its hook's `with` (`with.harness`: the calling file names its
// sub-agent, so all of a system's harnesses are in one resolved document); a tool takes it from its arguments
// (`harness`: an orchestrator's model writes a sub-agent at runtime). The launched run inherits none of the
// caller's hooks and is not narrowed against the caller's harness (unlike `core_spawn`, §10). It is a top-level run
// of its own: one user message, the task the binding makes from its input, and its log is not the caller's.
import { InfraFailure, run, type Host } from "./engine.js";
import { harnessErrors, type Harness } from "./harness.js";
import type { Log } from "./log.js";
import type { Json } from "./values.js";

export type Binding = (input: Json) => Promise<unknown>;

/** core_spawn's words (§10). */
const INVALID = "child harness is not valid";

const isObject = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/** The harness a binding is handed (§13.1): a hook input's `with.harness`, else a tool's `harness` argument. */
export function handedHarness(input: Json): unknown {
  if (isObject(input) && "event" in input && isObject(input.with)) return input.with.harness;
  return isObject(input) ? input.harness : undefined;
}

/** The text of the run's last top-level assistant entry, "" if none (as `core_spawn` returns it, §10). */
export function finalText(log: Log): string {
  const last = log.entries.findLast((e) => e.type === "assistant" && e.depth === undefined);
  return (last?.text as string | undefined) ?? "";
}

export interface LaunchOptions {
  /** Picks the handed harness; by default `handedHarness`. */
  harness?: (input: Json) => unknown;
  /** The answer from the log of a run that ended with `stop` or `limit`; by default `{ok: true, result: <its
   * final text>}`. */
  answer?: (log: Log) => unknown;
  /** Whether the launched run's deployment binds an id; a handed harness that declares another is not valid. */
  binds?: (id: string) => boolean;
  /** Receives every launched run's log, however it ended, for the host to keep. */
  onLog?: (log: Log) => void;
}

/** A binding (input → answer, §3.3) that runs the harness it is handed on `host`, `task(input)` its only user
 * message. A handed harness that isn't valid (§2, §3, §5.1), or declares an id the launched run's deployment doesn't
 * bind, gets `ok: false`, `child harness is not valid`: world feedback for a tool, a failed hook for a handler
 * (§5.4). `host` serves the launched run (its model transport and its own bindings); its `user()` is never asked.
 * A task that isn't a string is an infrastructure failure. A run that ends with `infra_failure` or `host_end`
 * leaves the binding without an answer: InfraFailure, the caller's infrastructure failure (§3.3). */
export function harnessBinding(host: Host, task: (input: Json) => unknown, options: LaunchOptions = {}): Binding {
  const pick = options.harness ?? handedHarness;
  return async (input) => {
    const handed = pick(input);
    if (harnessErrors(handed).length > 0 || (options.binds && !declared(handed as Harness).every(options.binds))) {
      return { ok: false, error: INVALID };
    }
    const text = task(input);
    if (typeof text !== "string") throw new InfraFailure("the binding's task is not a string");
    const log = await run(handed as Harness, oneTask(host, text));
    options.onLog?.(log);
    const reason = log.entries.at(-1)!.reason;
    if (reason === "infra_failure" || reason === "host_end") throw new InfraFailure(`the launched run ended with ${reason}`);
    return options.answer ? options.answer(log) : { ok: true, result: finalText(log) };
  };
}

/** The ids a deployment binds for a harness (§13): its tools and handlers, built-ins aside. */
function declared(harness: Harness): string[] {
  return [...Object.keys(harness.tools ?? {}), ...Object.keys(harness.handlers ?? {})].filter((id) => id !== "core_spawn");
}

/** The launched run's host: the task is its only user message; everything else is the given host's. */
function oneTask(host: Host, task: string): Host {
  let pending = true;
  return {
    async user() {
      if (!pending) return null;
      pending = false;
      return task;
    },
    model: (request) => host.model(request),
    call: (id, input) => host.call(id, input),
    interrupts: (step) => host.interrupts(step),
    ...(host.harness && { harness: (step: number) => host.harness!(step) }),
    ...(host.reasons && { reasons: (tool: string, args: Json) => host.reasons!(tool, args) }),
  };
}
