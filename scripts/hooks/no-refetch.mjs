#!/usr/bin/env node
/*
 * no-refetch.mjs — PreToolUse guard against re-reading a file that hasn't changed.
 *
 * Wired into every dispatched worker (app/src/lib/worker-hooks.ts).
 *
 * WHY THIS EXISTS
 *
 * Measured on 2026-08-19 across Devin's last 25 dispatches: 331 reads were of a
 * file the same dispatch had already read. One log file was re-read 124 extra
 * times, another 96. That is an agent polling for a change by re-reading.
 *
 * It is the most expensive habit in the system, because it compounds twice:
 * every re-read appends the whole file to the context AGAIN, and then every
 * later turn in that session pays to read the enlarged context. A worker
 * averages ~100 turns, so a 5k-token file re-read 100 times does not cost 500k
 * tokens, it costs that plus the growth tax on every turn that follows.
 *
 * WHAT IT DOES
 *
 * Denies a Read when this same session already read that exact file and the file
 * is provably unchanged (identical size AND modification time) within the last
 * 10 minutes. Everything else is allowed:
 *
 *   - the file changed (an edit, a build, a log that actually grew) -> allowed,
 *     which is the whole point: real changes must always get through
 *   - a partial read (offset/limit) -> allowed, that is deliberate paging
 *   - the same file much later -> allowed, the window has passed and the
 *     conversation may have been compacted since
 *   - anything the guard cannot verify (no session id, unreadable state, missing
 *     file) -> allowed
 *
 * Escape hatch: after 2 denials for the same file the third attempt is allowed.
 * A guard that can trap an agent in a loop is worse than the waste it prevents.
 *
 * Deny contract matches the other hooks: exit 0 with
 * {hookSpecificOutput:{permissionDecision:"deny", ...}}. The reason teaches the
 * cheaper alternative rather than just refusing.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Unchanged re-reads inside this window are the polling pattern we're stopping. */
const WINDOW_MS = 10 * 60 * 1000;
/** Records older than this are dropped so the state file can't grow forever. */
const KEEP_MS = 60 * 60 * 1000;
/** Let the agent through after this many denials for one file. */
const MAX_DENIALS = 2;

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  allow();
}
if (!input || typeof input !== "object") allow();
if (input.tool_name !== "Read") allow();

const ti = input.tool_input || {};
// Paging through a big file on purpose. Not the pattern we're after.
if (ti.offset !== undefined || ti.limit !== undefined) allow();

const sessionId = input.session_id;
if (!sessionId || typeof sessionId !== "string") allow(); // can't scope state safely

let filePath = ti.file_path;
if (!filePath || typeof filePath !== "string") allow();
if (!path.isAbsolute(filePath) && input.cwd) filePath = path.join(input.cwd, filePath);

let st;
try {
  st = fs.statSync(filePath);
} catch {
  allow(); // missing/unreadable — let the Read tool report it properly
}
if (!st.isFile()) allow();

const stateDir = path.join(os.tmpdir(), "aiteam-refetch");
const stateFile = path.join(stateDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
const key = filePath.replace(/\\/g, "/").toLowerCase();
const now = Date.now();

let state = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (!state || typeof state !== "object") state = {};
} catch {
  state = {};
}

const prior = state[key];
const unchanged =
  prior &&
  prior.mtimeMs === st.mtimeMs &&
  prior.size === st.size &&
  now - prior.at < WINDOW_MS;

function save(rec) {
  try {
    state[key] = rec;
    for (const [k, v] of Object.entries(state)) {
      if (!v || typeof v.at !== "number" || now - v.at > KEEP_MS) delete state[k];
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
  } catch {
    /* state is an optimization; never block on it */
  }
}

if (unchanged && (prior.denials || 0) < MAX_DENIALS) {
  const secs = Math.max(1, Math.round((now - prior.at) / 1000));
  save({ ...prior, denials: (prior.denials || 0) + 1 });
  const name = path.basename(filePath);
  deny(
    `You already read ${name} ${secs}s ago in this session and it has not changed since ` +
      `(same size, same modification time). Its contents are still above in this ` +
      `conversation — use them instead of reading it again.\n\n` +
      `If you are WAITING for this file to change, do not poll it with Read: each read ` +
      `copies the whole file into context again and every later step pays for it. Use the ` +
      `Monitor tool to wait for the change, or run the command that produces the file and ` +
      `read its output directly.\n\n` +
      `If you genuinely need a fresh look at part of it, read a range with offset/limit, ` +
      `which is always allowed.`
  );
}

// Allowed: record what we saw so the next identical read can be caught. A read
// that got through after MAX_DENIALS resets the counter, so the guard re-arms
// once the agent has moved on.
save({ mtimeMs: st.mtimeMs, size: st.size, at: now, denials: 0 });
allow();
