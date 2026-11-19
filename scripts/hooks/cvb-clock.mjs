#!/usr/bin/env node
/*
 * cvb-clock.mjs — UserPromptSubmit hook for CVB's dashboard chat sessions.
 *
 * Injects the owner's current local date and time into CVB's context on every turn,
 * so he always knows the real time of day (no more "get some sleep" at 10am).
 * Time zone: "timeZone" in ~/.aiteam/settings.json (an IANA name such as
 * "America/Chicago") if set and valid, otherwise this computer's own zone.
 * Runs as code per turn, so it's always fresh — unlike the persona, which only loads
 * at session creation and would go stale.
 *
 * Part of the agent-governance-lockdown project. See docs/agent-governance-lockdown-plan.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Drain stdin (the UserPromptSubmit payload); we don't need its contents.
try {
  fs.readFileSync(0, "utf8");
} catch {
  /* no stdin is fine */
}

function configuredZone() {
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".aiteam", "settings.json"), "utf8")
    );
    const tz = typeof s.timeZone === "string" ? s.timeZone.trim() : "";
    if (!tz) return null;
    new Intl.DateTimeFormat("en-US", { timeZone: tz }); // throws if unknown
    return tz;
  } catch {
    return null;
  }
}

const timeZone =
  configuredZone() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const stamp = new Intl.DateTimeFormat("en-US", {
  timeZone,
  timeZoneName: "short",
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
      additionalContext: `Current date and time: ${stamp} (time zone ${timeZone}). Use this for any time-of-day judgment.`,
    },
  })
);
process.exit(0);
