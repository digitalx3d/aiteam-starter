#!/usr/bin/env node
/*
 * cvb-clock.mjs — UserPromptSubmit hook for CVB's dashboard chat sessions.
 *
 * Injects the current Phoenix (Arizona / MST) date+time into CVB's context on every
 * turn, so he always knows the real time of day (no more "get some sleep" at 10am).
 * Runs as code per turn, so it's always fresh — unlike the persona, which only loads
 * at session creation and would go stale.
 *
 * Part of the agent-governance-lockdown project. See docs/agent-governance-lockdown-plan.md.
 */
import fs from "node:fs";

// Drain stdin (the UserPromptSubmit payload); we don't need its contents.
try {
  fs.readFileSync(0, "utf8");
} catch {
  /* no stdin is fine */
}

const stamp = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Phoenix",
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
}).format(new Date());

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `Current date and time: ${stamp} (Phoenix, Arizona — MST, UTC-7, no daylight saving). Use this for any time-of-day judgment.`,
    },
  })
);
process.exit(0);
