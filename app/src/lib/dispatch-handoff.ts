import path from "node:path";
import fs from "node:fs";
import { getConfig } from "./config";

/*
 * dispatch-handoff.ts — the trigger layer for the self-handing-off team (Phase 5).
 *
 * When a dispatched worker ends its report with a ===HANDOFF=== directive, the
 * dispatch engine can auto-dispatch the named teammate to act on it — bounded by:
 *   - a REVIEW REQUEST on the originating dispatch (2026-08-20): a
 *     handoff fires ONLY inside a line of work CVB explicitly marked. Devin no
 *     longer sends himself to Ethan for every non-trivial diff; CVB decides when
 *     security matters and says so when he dispatches. A worker cannot authorize
 *     its own review, because the flag is set by the dispatcher, not by anything
 *     the worker writes in its report.
 *   - a KILL SWITCH (off by default; opt-in via a flag file),
 *   - a WHITELIST of allowed (from -> to) pairs (hardcoded here, so an agent can't
 *     widen its own auto-dispatch policy by editing a data file),
 *   - a LOOP GOVERNOR (max chain depth), enforced in dispatch/route.ts.
 *
 * Everything else routes to CVB the normal way (the report bubble), so CVB stays
 * the router for anything not on the narrow whitelist.
 *
 * Part of the agent-governance-lockdown project. See docs/agent-governance-lockdown-plan.md
 * and vault/team/rules-handoff.md.
 */

/** Max auto-hops in a single chain before it must return to CVB. */
export const MAX_CHAIN_DEPTH = 3;

/**
 * Allowed auto-handoffs: from-agent -> the teammates it may auto-trigger.
 * Deliberately tiny and hardcoded. Everything not listed here does NOT auto-fire;
 * it surfaces to CVB as a normal report and CVB decides. Widening this is a code
 * change (which CVB's guard blocks him from making) — that's the point.
 */
const AUTO_HANDOFF_ALLOW: Record<string, string[]> = {
  // The flagship loop: Devin ships a diff -> Ethan reviews it; Ethan finds issues -> Devin fixes.
  devin: ["ethan"],
  ethan: ["devin"],
};

export function isHandoffAllowed(from: string, to: string): boolean {
  return (AUTO_HANDOFF_ALLOW[from.toLowerCase()] ?? []).includes(to.toLowerCase());
}

/**
 * Kill switch. Auto-handoff is OFF unless a flag file exists at
 * <aiteamDir>/.auto-handoff-enabled. Opt-in by design: agents auto-triggering each
 * other is powerful, so it ships disabled and the owner turns it on when they can watch.
 */
export function isAutoHandoffEnabled(): boolean {
  try {
    return fs.existsSync(path.join(getConfig().aiteamDir, ".auto-handoff-enabled"));
  } catch {
    return false;
  }
}

export interface Handoff {
  /** Target agent (lowercased). */
  to: string;
  /** Why — the context for the receiving agent. */
  why: string;
  /** Optional reference (task id, file, ticket). */
  ref: string | null;
}

const HANDOFF_RE = /===\s*HANDOFF\s*===\s*([\s\S]*?)(?:===\s*END\s*===|$)/i;

function pick(body: string, key: string): string | null {
  // "key: value" up to the next separator (newline, middot, or pipe).
  const m = body.match(new RegExp(`${key}\\s*:\\s*([^\\n·|]+)`, "i"));
  return m ? m[1].trim() || null : null;
}

/** Parse a `===HANDOFF=== to: <agent> · why: <text> · ref: <id> ===END===` block. */
export function extractHandoff(text: string | null): Handoff | null {
  if (!text) return null;
  const m = text.match(HANDOFF_RE);
  if (!m) return null;
  const body = m[1];
  const to = pick(body, "to");
  if (!to) return null;
  return {
    to: to.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
    why: pick(body, "why") ?? "",
    ref: pick(body, "ref"),
  };
}
