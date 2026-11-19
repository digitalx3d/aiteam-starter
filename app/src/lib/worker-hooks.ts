import path from "node:path";
import { getConfig } from "./config";

/**
 * Build the per-session Claude Code settings that wire the Live Feed hooks into
 * a dispatched worker.
 *
 * Passed via `--settings` on EVERY worker spawn (fresh or warm resume — see
 * api/dispatch/route.ts), so the posting contract re-asserts every turn and
 * cannot erode mid-session the way persona text can:
 *
 *  - PreToolUse (feed-guard.mjs): validates every now.md post — required
 *    `[project]` tag matching this dispatch, 20-60 words of plain English
 *    (no coder symbols, acronyms only in parentheses after the full name),
 *    Write tool only, own file only. Bad posts are denied with a teaching
 *    reason.
 *  - PostToolUse (feed-nudge.mjs): if the agent hasn't posted in 7+ minutes,
 *    injects a reminder to post a progress update.
 *  - PostToolUse on Write (feed-post.mjs): copies each accepted now.md post into
 *    this dispatch's own post file, posts/<ticketId>.md. Parallel workers of the
 *    same agent share one now.md; the ticket file is what keeps each slot's post
 *    visible in the feed (see lib/feed-posts.ts).
 *
 * With a ticket id, feed-nudge also measures silence against the ticket's post
 * file, so a sibling slot's fresh post can't hide this worker going quiet.
 *
 * The canonical posting rules live in vault/team/operating-rules.md ("Live
 * Feed" section); these hooks are the enforcement layer for them.
 */
export function buildWorkerFeedHookSettings(
  agent: string,
  project: string | null,
  ticketId?: string | null
): Record<string, unknown> {
  const cfg = getConfig();
  const hooksDir = path.join(cfg.aiteamDir, "scripts", "hooks");
  // Forward slashes so the paths need no escaping inside the shell command string.
  const guard = path.join(hooksDir, "feed-guard.mjs").replace(/\\/g, "/");
  const nudge = path.join(hooksDir, "feed-nudge.mjs").replace(/\\/g, "/");
  const post = path.join(hooksDir, "feed-post.mjs").replace(/\\/g, "/");
  const noRefetch = path.join(hooksDir, "no-refetch.mjs").replace(/\\/g, "/");
  const rulesGuard = path.join(hooksDir, "rules-guard.mjs").replace(/\\/g, "/");
  const agentsDir = cfg.agentsDir.replace(/\\/g, "/");
  // Feed posts for non-project dispatches are tagged with the team's own label.
  const label = project ?? "aiteam";
  const args = `--agent "${agent}" --project "${label}" --agents-dir "${agentsDir}"`;
  // Ticket ids are UUIDs; anything else is dropped rather than quoted into a shell.
  const ticket = ticketId && /^[A-Za-z0-9_-]+$/.test(ticketId) ? ticketId : null;
  const ticketArgs = ticket ? `${args} --ticket "${ticket}"` : args;
  const postToolUse: Record<string, unknown>[] = [
    { hooks: [{ type: "command", command: `node "${nudge}" ${ticketArgs}` }] },
  ];
  if (ticket) {
    postToolUse.push({
      matcher: "Write",
      hooks: [{ type: "command", command: `node "${post}" ${ticketArgs}` }],
    });
  }
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
          hooks: [
            { type: "command", command: `node "${guard}" ${args}` },
            // Team rules that are code, not prose: reserved ports, persona
            // location, no em dashes. See scripts/hooks/rules-guard.mjs.
            { type: "command", command: `node "${rulesGuard}"` },
          ],
        },
        {
          // Read only: everything else is none of this guard's business.
          matcher: "Read",
          hooks: [{ type: "command", command: `node "${noRefetch}"` }],
        },
      ],
      PostToolUse: postToolUse,
    },
  };
}
