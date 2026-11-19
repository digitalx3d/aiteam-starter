import path from "node:path";
import { getConfig } from "./config";

/**
 * Build the per-session Claude Code settings that wire CVB's guard + clock hooks.
 *
 * Passed via `--settings` on EVERY dashboard chat spawn (see api/chat/route.ts),
 * so the enforcement re-asserts every turn and survives session resumes — unlike
 * the persona, which only loads at session creation. Applies ONLY to CVB's chat
 * sessions; dispatched workers and terminal/Cursor Claudes never receive it.
 *
 *  - PreToolUse (cvb-guard.mjs): hard-blocks Edit/Write/Bash to deliverable or
 *    governance files; CVB may only write coordination artifacts.
 *  - PreToolUse (feed-guard.mjs): validates CVB's own Live Feed posts (now.md)
 *    against the team posting contract. `--project any` because CVB works
 *    across projects — a [project] tag is still required, its value is free.
 *  - UserPromptSubmit (cvb-clock.mjs): injects the owner's local time each turn.
 *
 * Part of the agent-governance-lockdown project.
 */
export function buildCvbHookSettings(): Record<string, unknown> {
  const cfg = getConfig();
  const hooksDir = path.join(cfg.aiteamDir, "scripts", "hooks");
  // Forward slashes so the path needs no escaping inside the shell command string.
  const guard = path.join(hooksDir, "cvb-guard.mjs").replace(/\\/g, "/");
  const clock = path.join(hooksDir, "cvb-clock.mjs").replace(/\\/g, "/");
  const feedGuard = path.join(hooksDir, "feed-guard.mjs").replace(/\\/g, "/");
  const agentsDir = cfg.agentsDir.replace(/\\/g, "/");
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
          hooks: [
            { type: "command", command: `node "${guard}"` },
            {
              type: "command",
              command: `node "${feedGuard}" --agent "claude" --project "any" --agents-dir "${agentsDir}"`,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: `node "${clock}"` }],
        },
      ],
    },
  };
}
