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
 *
 * The canonical posting rules live in vault/team/operating-rules.md ("Live
 * Feed" section); these hooks are the enforcement layer for them.
 */
export function buildWorkerFeedHookSettings(
  agent: string,
  project: string | null
): Record<string, unknown> {
  const cfg = getConfig();
  const hooksDir = path.join(cfg.aiteamDir, "scripts", "hooks");
  // Forward slashes so the paths need no escaping inside the shell command string.
  const guard = path.join(hooksDir, "feed-guard.mjs").replace(/\\/g, "/");
  const nudge = path.join(hooksDir, "feed-nudge.mjs").replace(/\\/g, "/");
  const agentsDir = cfg.agentsDir.replace(/\\/g, "/");
  // Feed posts for non-project dispatches are tagged with the team's own label.
  const label = project ?? "aiteam";
  const args = `--agent "${agent}" --project "${label}" --agents-dir "${agentsDir}"`;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
          hooks: [{ type: "command", command: `node "${guard}" ${args}` }],
        },
      ],
      PostToolUse: [
        {
          hooks: [{ type: "command", command: `node "${nudge}" ${args}` }],
        },
      ],
    },
  };
}
