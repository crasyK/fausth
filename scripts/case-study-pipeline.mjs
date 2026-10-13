/**
 * Host-side pipeline helpers (contract v0.3, docs/spec-v0.3.md).
 * Faust does not own sequencing; the runner decides when each phase starts.
 *
 * - A run (phase) is complete only when the engine records
 *   `record`/`allow`/`run_complete` for the harness's terminal tool (§6.5, §8.2).
 *   There is no `phase_yielded` reason any more; a phase that ends by yielding
 *   declares its yield tool as `counterbalance.completion.tool`.
 * - A call is successful only when it was executed AND verified (D8): its
 *   `execute`/`allow` is followed by `verify`/`allow` before the next proposal.
 */

/** @param {string} eventsText */
function parseEvents(eventsText) {
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const line of String(eventsText ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

/**
 * Calls that succeeded under D8 (executed and every verify passed), in order.
 * A call spans from its `propose` to the next `propose`; any `deny` in that span
 * (verify failure, infra failure, gate) means the call did not succeed.
 * @param {string} eventsText
 * @returns {Array<{ tool: string, args: Record<string, any> | null, result: unknown }>}
 */
export function successfulCalls(eventsText) {
  /** @type {Array<{ tool: string, args: Record<string, any> | null, result: unknown }>} */
  const out = [];
  /** @type {{ tool: string, args: Record<string, any> | null, executed: boolean, verified: boolean, result: unknown, failed: boolean } | null} */
  let cur = null;
  const close = () => {
    if (cur && cur.executed && cur.verified && !cur.failed) {
      out.push({ tool: cur.tool, args: cur.args, result: cur.result });
    }
    cur = null;
  };
  for (const e of parseEvents(eventsText)) {
    if (e.stage === "propose") {
      close();
      if (e.tool) {
        cur = { tool: String(e.tool), args: e.args ?? null, executed: false, verified: false, result: undefined, failed: false };
      }
      continue;
    }
    if (!cur) continue;
    if (e.verdict === "deny") cur.failed = true;
    else if (e.stage === "execute" && e.verdict === "allow" && (e.tool == null || e.tool === cur.tool)) {
      cur.executed = true;
      cur.result = e.result;
    } else if (e.stage === "verify" && e.verdict === "allow" && cur.executed) {
      cur.verified = true;
    }
  }
  close();
  return out;
}

/**
 * @param {string} eventsText
 * @param {string} tool
 */
export function toolSucceeded(eventsText, tool) {
  return successfulCalls(eventsText).some((c) => c.tool === tool);
}

/**
 * The run's terminal tool succeeded: `record`/`allow`/`run_complete` (optionally for `tool`).
 * @param {string} eventsText
 * @param {string} [tool]
 */
export function runCompleted(eventsText, tool) {
  return parseEvents(eventsText).some(
    (e) =>
      e.stage === "record" &&
      e.verdict === "allow" &&
      e.reason === "run_complete" &&
      (tool === undefined || e.tool === tool),
  );
}

/** A phase is complete when its declared terminal tool succeeded (`run_complete`). */
export function phaseCompleted(eventsText) {
  return runCompleted(eventsText);
}

/**
 * The plan was approved: a successful (D8) user.approve whose user answer
 * approved it (`approved: 1` when the answer carries the field).
 * @param {string} eventsText
 */
export function planApproved(eventsText) {
  return successfulCalls(eventsText).some((c) => {
    if (c.tool !== "user.approve") return false;
    const r = c.result;
    if (r && typeof r === "object" && "approved" in r) return Number(/** @type {any} */ (r).approved) === 1;
    return true;
  });
}

/**
 * Implementation must not start unless the plan was approved.
 * @param {string} planEventsText
 */
export function shouldStartImplementation(planEventsText) {
  return planApproved(planEventsText);
}
