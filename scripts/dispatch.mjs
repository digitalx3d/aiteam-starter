#!/usr/bin/env node
// Von Braun's dispatch helper. Hands off work to a teammate as a top-level
// claude.exe process so the dashboard chat stays unblocked. Prints the
// dashboard's reply on stdout as it came: one line of JSON, `{"ticketId":"..."}`
// (app/src/app/api/dispatch/route.ts). Read `ticketId`, not `id`; a caller that
// reads `.id` takes every success for a failure.
// The worker runs in the background; its completion lands as a "report" message in the dashboard chat via the
// /api/dispatch/events SSE stream.
//
// Usage:
//   node scripts/dispatch.mjs --agent <name> [--project <slug>] --brief "<text>"
//
// Or read the brief from a file (useful for multi-paragraph briefs):
//   node scripts/dispatch.mjs --agent devin --project my-app --brief-file brief.md
//
// Optional per-dispatch overrides. Both beat the agent's frontmatter defaults
// (~/.claude/agents/<name>.md) and apply to this one dispatch only:
//   --model <alias>    e.g. opus, sonnet, haiku
//   --effort <level>   one of: low, medium, high, xhigh, max
//                      (ignored by models that don't support it, e.g. haiku)
//
//   node scripts/dispatch.mjs --agent devin --project my-app --effort low --brief "..."
//
// Dispatch queue: start a job only after another one
// finishes successfully, so a chain runs without CVB waking up between steps.
//   --after <ticketId>  queue this job behind that ticket (the full id this
//                       script printed, or its first 8 characters). Returns a
//                       ticket id right away, the same as a normal dispatch;
//                       the job waits and starts by itself when that ticket
//                       finishes successfully. Chains work: queue C --after B
//                       using the id B's dispatch returned.
//                       If that ticket fails, is cancelled, or its worker
//                       reports blocked, the job does NOT start: it shows as
//                       "waiting on a failed job" and its report in the chat
//                       says so. At most 10 jobs may wait at once.
//   --cancel <ticketId> remove a job that is still waiting. Needs no other flag.
//   --queue             list what is waiting. Needs no other flag.
//
//   A=$(node scripts/dispatch.mjs --agent casey --project my-app --brief-file copy.md)
//   node scripts/dispatch.mjs --agent maya --project my-app --after <A's ticketId> --brief-file cover.md
//   node scripts/dispatch.mjs --cancel 3f2a9c1e
//
// Switched off by `"dispatchQueue": false` in ~/.aiteam/settings.json: --after
// is refused and nothing waiting starts. See
// docs/dispatch-queue.md, "How to undo".

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const flags = parseArgs(process.argv.slice(2));

// --cancel and --queue talk to the queue only; they need no agent or brief.
const queueMode = flags.cancel !== undefined || flags.queue !== undefined;

if (!queueMode && !flags.agent) {
  console.error("error: --agent <name> is required");
  process.exit(2);
}

let brief = typeof flags.brief === "string" ? flags.brief : null;
if (!brief && typeof flags["brief-file"] === "string") {
  try {
    brief = readFileSync(flags["brief-file"], "utf8");
  } catch (err) {
    console.error(`error: cannot read --brief-file: ${err.message}`);
    process.exit(2);
  }
}
if (!queueMode && !brief) {
  console.error("error: --brief <text> or --brief-file <path> is required");
  process.exit(2);
}

// Dashboard port: DISPATCH_URL wins outright, then ~/.aiteam/settings.json
// appPort (the installed port), then 3900. Never the generic PORT environment
// variable: a stray PORT left by some other tool would silently send the
// courier to the wrong place, and the failure looks like a broken teammate
// rather than a broken messenger.
function resolvePort() {
  try {
    const s = JSON.parse(
      readFileSync(join(homedir(), ".aiteam", "settings.json"), "utf8")
    );
    if (s.appPort) return String(s.appPort);
  } catch {
    /* fall through */
  }
  return "3900";
}
const url =
  process.env.DISPATCH_URL || `http://localhost:${resolvePort()}/api/dispatch`;

if (queueMode) {
  await queueCommand();
  process.exit(0);
}

// A bare `--effort` (no value) parses as boolean true. Catch it here rather
// than silently dropping the flag the caller clearly meant to use.
for (const key of ["model", "effort", "after"]) {
  if (flags[key] === true) {
    console.error(`error: --${key} requires a value`);
    process.exit(2);
  }
}

const body = {
  agent: String(flags.agent),
  project:
    typeof flags.project === "string" && flags.project.length > 0
      ? flags.project
      : null,
  brief,
};

// Omit these keys entirely when unset, so the API falls through to the agent's
// frontmatter defaults instead of seeing an explicit null.
if (typeof flags.model === "string" && flags.model.length > 0) {
  body.model = flags.model;
}
if (typeof flags.effort === "string" && flags.effort.length > 0) {
  body.effort = flags.effort;
}
if (typeof flags.after === "string" && flags.after.length > 0) {
  body.after = flags.after;
}

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`error: non-JSON response (status ${res.status}):`, text);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`error: dispatch failed (status ${res.status}):`, json);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(json) + "\n");
} catch (err) {
  console.error(`error: dispatch request failed: ${err.message}`);
  console.error(
    `(is the aiTeam app running at ${url}? set appPort in ~/.aiteam/settings.json, or DISPATCH_URL, to override.)`
  );
  process.exit(1);
}

/** --cancel <ticketId> and --queue. Exits non-zero with the server's plain
 *  error when the queue refuses. */
async function queueCommand() {
  if (flags.cancel === true) {
    console.error("error: --cancel requires a ticket id");
    process.exit(2);
  }
  const target =
    flags.cancel !== undefined
      ? `${url}/queue/${encodeURIComponent(String(flags.cancel))}`
      : `${url}/queue`;
  let res, json;
  try {
    res = await fetch(target, { method: flags.cancel !== undefined ? "DELETE" : "GET" });
    json = JSON.parse(await res.text());
  } catch (err) {
    console.error(`error: queue request failed: ${err.message}`);
    console.error(`(is the aiTeam app running at ${url}?)`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`error: ${json.error ?? `status ${res.status}`}`);
    process.exit(1);
  }
  if (flags.cancel !== undefined) {
    process.stdout.write(JSON.stringify(json) + "\n");
    return;
  }
  if (!json.enabled) console.log('(the dispatch queue is switched off: nothing below will start until "dispatchQueue" is true again)');
  if (json.jobs.length === 0) {
    console.log("nothing is waiting");
    return;
  }
  for (const j of json.jobs) {
    const state =
      j.state === "blocked"
        ? `waiting on a failed job (${j.reason})`
        : j.state === "held"
          ? `held for the usage limit until ${new Date(j.holdUntil).toLocaleTimeString()} (${j.reason})`
          : `queued after ${j.afterAgent ?? "?"} ${j.after.slice(0, 8)}`;
    const title = j.brief.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 70) ?? "";
    console.log(`${j.id}  ${j.agent}${j.project ? ` [${j.project}]` : ""}  ${state}`);
    console.log(`    ${title}`);
  }
}
