/**
 * Host-side pipeline helpers for the coding-counterbalance case study.
 * Faust does not own sequencing; the runner decides when each phase starts.
 */

/**
 * @param {string} eventsText
 * @param {string} tool
 */
export function toolExecuted(eventsText, tool) {
  return eventsText.split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      const e = JSON.parse(line);
      return e.tool === tool && e.stage === "execute" && e.verdict === "allow";
    } catch {
      return false;
    }
  });
}

/** @param {string} eventsText */
export function phaseYielded(eventsText) {
  return toolExecuted(eventsText, "phase.yield");
}

/** @param {string} eventsText */
export function planApproved(eventsText) {
  return toolExecuted(eventsText, "user.approve");
}

/**
 * Implementation must not start unless plan approved.
 * @param {string} planEventsText
 */
export function shouldStartImplementation(planEventsText) {
  return planApproved(planEventsText);
}
