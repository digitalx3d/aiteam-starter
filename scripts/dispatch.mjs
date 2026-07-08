#!/usr/bin/env node
// Von Braun's dispatch helper. Hands off work to a teammate as a top-level
// claude.exe process so the dashboard chat stays unblocked. Returns a JSON
// ticket (with .id) on stdout. The worker runs in the background; its
// completion lands as a "report" message in the dashboard chat via the
// /api/dispatch/events SSE stream.
//
// Usage:
//   node scripts/dispatch.mjs --agent <name> [--project <slug>] --brief "<text>"
//
// Or read the brief from a file (useful for multi-paragraph briefs):
//   node scripts/dispatch.mjs --agent devin --project my-app --brief-file brief.md

import { readFileSync } from "node:fs";

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

if (!flags.agent) {
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
if (!brief) {
  console.error("error: --brief <text> or --brief-file <path> is required");
  process.exit(2);
}

// Default to 3900 — the aiTeam dashboard's reserved port (see
// Z:\GitHub\vault\team\rules.md "Reserved ports"). Was 3000 until 2026-05-29,
// when clearing the machine-level PORT=3900 env var (Devin's 5/20 footgun fix)
// silently broke this fallback because $PORT was empty and the script fell
// through to 3000 where nothing was listening.
const url =
  process.env.DISPATCH_URL ||
  `http://localhost:${process.env.PORT || 3900}/api/dispatch`;

const body = {
  agent: String(flags.agent),
  project:
    typeof flags.project === "string" && flags.project.length > 0
      ? flags.project
      : null,
  brief,
};

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
    `(is the aiTeam app running at ${url}? set DISPATCH_URL or PORT to override.)`
  );
  process.exit(1);
}
