import { extractHandoff, isHandoffAllowed, MAX_CHAIN_DEPTH, type Handoff } from "./dispatch-handoff";

/*
 * review-gate.ts: decides, when a dispatched worker finishes, whether the
 * security review CVB asked for on this line of work starts, and if it can't,
 * why. Pure so it can be tested without spawning anything; dispatch/route.ts
 * does the dispatching.
 *
 * Fail closed, loudly. Before 2026-10-07 every "no" here was a silent return,
 * and a project-less review (ticket f1fdb06f, the job runner) never fired while
 * CVB believed it was coming. Now every "no" on a review-flagged dispatch comes
 * back with a reason, and the route puts that reason in front of CVB.
 */

/** The teammate who does security review. His own report ending without a
 *  handoff is the review finishing, not a review failing to start. */
export const REVIEWER = "ethan";

export type ReviewPlan =
  /** No review was asked for on this dispatch, or the reviewer finished cleanly. */
  | { kind: "none" }
  /** Dispatch the handoff. */
  | { kind: "fire"; handoff: Handoff }
  /** A review (or the reviewer's hand-back) was due and will not start. */
  | { kind: "not-started"; reason: string };

export function planReviewHandoff(input: {
  agent: string;
  securityReview: boolean;
  chainDepth: number;
  text: string | null;
  autoHandoffEnabled: boolean;
}): ReviewPlan {
  // A review is not automatic. It happens when CVB
  // asked for one on this line of work. The flag comes from the dispatcher, so
  // a worker emitting a HANDOFF block on its own gets nowhere.
  if (!input.securityReview) return { kind: "none" };

  const agent = input.agent.toLowerCase();
  const h = extractHandoff(input.text);
  const isReviewer = agent === REVIEWER;
  // The reviewer with nothing to hand back has done the review.
  if (isReviewer && !h) return { kind: "none" };

  if (!input.autoHandoffEnabled) {
    return { kind: "not-started", reason: "auto-handoff is switched off (no .auto-handoff-enabled file in the aiTeam folder)" };
  }
  if (input.chainDepth >= MAX_CHAIN_DEPTH) {
    return {
      kind: "not-started",
      reason: `this line of work already used all ${MAX_CHAIN_DEPTH} automatic hops; CVB has to dispatch the next one`,
    };
  }
  if (!h) {
    return {
      kind: "not-started",
      reason: `${input.agent}'s report has no ===HANDOFF=== block naming ${REVIEWER}`,
    };
  }
  if (!h.to) {
    return { kind: "not-started", reason: "the ===HANDOFF=== block names no teammate" };
  }
  if (!isHandoffAllowed(agent, h.to)) {
    return {
      kind: "not-started",
      reason: `a handoff from ${input.agent} to ${h.to} is not on the automatic list; CVB has to route it`,
    };
  }
  return { kind: "fire", handoff: h };
}

/** The line CVB sees at the top of the worker's summary. */
export function reviewNotStartedLine(agent: string, reason: string): string {
  const what = agent.toLowerCase() === REVIEWER ? "Hand-back from the security review" : "Security review";
  return `[review check] ${what} requested but NOT started: ${reason}.`;
}
