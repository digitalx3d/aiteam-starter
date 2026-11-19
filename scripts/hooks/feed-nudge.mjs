#!/usr/bin/env node
/*
 * feed-nudge.mjs — PostToolUse progress reminder for the Live Feed.
 *
 * Wired into every dispatched worker (via --settings, generated per spawn by
 * app/src/lib/worker-hooks.ts). After each tool call it checks how long ago the
 * agent last posted to its now.md. If the last post is older than the threshold
 * (default 7 minutes), it injects a reminder into the agent's context telling it
 * to post a progress update. This is what makes "long tasks post progress" a
 * code-enforced behavior instead of a persona suggestion.
 *
 * A cooldown marker (.feed-nudge in the agent's folder) throttles repeat
 * reminders so an agent that is mid-way through honoring one isn't spammed on
 * every subsequent tool call.
 *
 * With --ticket (every dispatched worker gets one), silence is measured against
 * that dispatch's own post file, posts/<ticket>.md, which feed-post.mjs updates
 * on each accepted post. Parallel workers share now.md, so its timestamp says
 * "some slot posted", not "this one did". The cooldown marker is per ticket too.
 * Without --ticket it measures now.md, as it always has.
 *
 * Invocation: node feed-nudge.mjs --agent <name> --project <label> --agents-dir <path>
 *             [--ticket <id>] [--threshold-min 7] [--cooldown-min 3]
 *
 * Fail-open: any error => exit 0 with no output; a broken nudge never breaks a run.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The human owner's first name, from ~/.aiteam/settings.json (same source as
// the app's Settings page). Fallback keeps the nudge working unconfigured.
function ownerFirst() {
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".aiteam", "settings.json"), "utf8")
    );
    const full = String(s.ownerName || "").trim();
    if (full) return full.split(/\s+/)[0];
  } catch {
    /* fall through */
  }
  return (process.env.AITEAM_OWNER_NAME || "").trim().split(/\s+/)[0] || "the boss";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

try {
  // Drain stdin (the PostToolUse payload); we only need time-since-last-post.
  try {
    fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin is fine */
  }

  const flags = parseArgs(process.argv.slice(2));
  const agent = typeof flags.agent === "string" ? flags.agent : null;
  const project = typeof flags.project === "string" ? flags.project : "aiteam";
  const agentsDir = typeof flags["agents-dir"] === "string" ? flags["agents-dir"] : null;
  if (!agent || !agentsDir) process.exit(0);

  const thresholdMs =
    (Number.isFinite(Number(flags["threshold-min"])) ? Number(flags["threshold-min"]) : 7) * 60_000;
  const cooldownMs =
    (Number.isFinite(Number(flags["cooldown-min"])) ? Number(flags["cooldown-min"]) : 3) * 60_000;

  const ticket =
    typeof flags.ticket === "string" && /^[A-Za-z0-9_-]+$/.test(flags.ticket) ? flags.ticket : null;
  const nowMd = path.join(agentsDir, agent, "now.md");
  const postFile = ticket ? path.join(agentsDir, agent, "posts", `${ticket}.md`) : nowMd;
  const marker = ticket
    ? path.join(agentsDir, agent, "posts", `${ticket}.nudge`)
    : path.join(agentsDir, agent, ".feed-nudge");
  const now = Date.now();

  let lastPost = 0;
  try {
    lastPost = fs.statSync(postFile).mtimeMs;
  } catch {
    /* no post yet — treat as overdue */
  }
  if (now - lastPost < thresholdMs) process.exit(0);

  // Cooldown: don't repeat the reminder on every tool call while it's being honored.
  try {
    const lastNudge = Number(fs.readFileSync(marker, "utf8"));
    if (Number.isFinite(lastNudge) && now - lastNudge < cooldownMs) process.exit(0);
  } catch {
    /* no marker — first nudge */
  }
  try {
    fs.writeFileSync(marker, String(now), "utf8");
  } catch {
    /* best-effort */
  }

  const minutes = lastPost ? Math.round((now - lastPost) / 60_000) : null;
  const since = minutes ? `It has been ${minutes} minutes since your last Live Feed post` : `You have not posted to the Live Feed yet`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `${since}. ${ownerFirst()} watches the feed to know you're alive and making progress. ` +
          `Before your next step, Write a progress update to ${nowMd}: 20-60 words of plain English ` +
          `(no coder symbols or bare acronyms), first line "working [${project}] — <what you're doing>", ` +
          `then what you've finished, what you found, and what's next. Then continue the task.`,
      },
    })
  );
  process.exit(0);
} catch {
  process.exit(0); // fail-open, always
}
