// Auto-commit triggers (short-term memory Priority 1, approved 2026-07-02).
//
// The End Session commit (archive -> distill -> fresh primer) used to fire
// ONLY when John clicked the button. This module is the safety net behind
// the button: it walks the dashboard's chat-state files and auto-commits any
// chat session that is
//   (a) IDLE  - no session-log activity for AUTOCOMMIT_IDLE_HOURS (default 72), or
//   (b) HEAVY - estimated tokens past AUTOCOMMIT_TOKENS (default 120k, same
//       bytes/4 heuristic the warm pool uses) AND quiet for at least
//       AUTOCOMMIT_QUIET_MINUTES (default 30) - the busy guard: a session
//       with recent log writes is mid-conversation and is never touched.
//
// It commits through the app's real end-session route (non-direct mode), so
// the exact same code path as the button runs: archive, chat-state reset,
// async distillation. Nothing here re-implements the commit.

import fs from "node:fs";
import path from "node:path";

const IDLE_HOURS = Number(process.env.AUTOCOMMIT_IDLE_HOURS || 72);
const HEAVY_TOKENS = Number(process.env.AUTOCOMMIT_TOKENS || 120_000);
const QUIET_MINUTES = Number(process.env.AUTOCOMMIT_QUIET_MINUTES || 30);
// Smooth the first-activation burst: many long-idle chats would all qualify
// at once, each firing a Sonnet distill. Commit a couple per sweep instead.
const MAX_COMMITS_PER_SWEEP = 2;
// Don't re-attempt a scope that just failed (e.g. app briefly down).
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

const lastAttempt = new Map(); // scope label -> epoch ms

function chatStatesDir(cfg) {
  return path.join(cfg.aiteamDir, "app", ".chat-states");
}

function encodeCwd(cwd) {
  return cwd.replace(/[:/\\]/g, "-");
}

/** Enumerate chat scopes from the .chat-states directory. */
export function listChatScopes(cfg) {
  const dir = chatStatesDir(cfg);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const scopes = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!state?.sessionId) continue;
    const stem = name.replace(/\.json$/, "");
    const slug = stem === "_default" ? null : stem.replace(/^project-/, "");
    if (stem !== "_default" && !stem.startsWith("project-")) continue;
    const cwd = slug
      ? path.join(cfg.projectsRoot, slug)
      : path.join(cfg.aiteamDir, "app");
    scopes.push({
      label: slug ? `project:${slug}` : "default",
      slug,
      cwd,
      sessionId: state.sessionId,
      stateFile: path.join(dir, name),
    });
  }
  return scopes;
}

/** Decide whether one scope qualifies. Returns {fire, reason} */
export function evaluateScope(cfg, scope, now = Date.now()) {
  const logPath = path.join(
    cfg.claudeProjectsDir,
    encodeCwd(scope.cwd),
    `${scope.sessionId}.jsonl`
  );
  let logStat = null;
  try {
    logStat = fs.statSync(logPath);
  } catch {
    /* no log yet */
  }

  if (!logStat) {
    // Zombie state: a session id was minted but never used. Clean it up only
    // once it is old (the route's empty-transcript path deletes the state).
    let stateStat;
    try {
      stateStat = fs.statSync(scope.stateFile);
    } catch {
      return { fire: false, reason: "state-vanished" };
    }
    const idleH = (now - stateStat.mtimeMs) / 36e5;
    return idleH >= IDLE_HOURS
      ? { fire: true, reason: `zombie state, ${idleH.toFixed(0)}h old` }
      : { fire: false, reason: "no-log-yet" };
  }

  const idleMs = now - logStat.mtimeMs;
  const idleH = idleMs / 36e5;
  const tokens = Math.round(logStat.size / 4);

  if (idleH >= IDLE_HOURS) {
    return {
      fire: true,
      reason: `idle ${idleH.toFixed(0)}h (threshold ${IDLE_HOURS}h), ~${tokens} tok`,
    };
  }
  if (tokens >= HEAVY_TOKENS) {
    if (idleMs < QUIET_MINUTES * 60_000) {
      return { fire: false, reason: `heavy (~${tokens} tok) but active ${Math.round(idleMs / 60000)}m ago - busy guard` };
    }
    return {
      fire: true,
      reason: `heavy ~${tokens} tok (threshold ${HEAVY_TOKENS}), quiet ${Math.round(idleMs / 60000)}m`,
    };
  }
  return { fire: false, reason: `healthy (~${tokens} tok, idle ${idleH.toFixed(1)}h)` };
}

async function callEndSession(cfg, scope) {
  const url =
    `${cfg.appUrl}/api/chat/end-session` +
    (scope.slug ? `?project=${encodeURIComponent(scope.slug)}` : "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { method: "POST", signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body?.ok !== false, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One auto-commit pass. Called from the vault-indexer sweep (every ~5 min)
 * and from the CLI. dryRun logs verdicts without committing anything.
 */
export async function autoCommitSweep(cfg, { dryRun = false, log = () => {} } = {}) {
  const scopes = listChatScopes(cfg);
  let fired = 0;
  const verdicts = [];
  for (const scope of scopes) {
    const verdict = evaluateScope(cfg, scope);
    verdicts.push({ scope: scope.label, ...verdict });
    if (!verdict.fire) continue;
    if (fired >= MAX_COMMITS_PER_SWEEP) {
      log(`autocommit: ${scope.label} qualifies (${verdict.reason}) - deferred to next sweep (burst cap)`);
      continue;
    }
    const last = lastAttempt.get(scope.label) || 0;
    if (Date.now() - last < RETRY_COOLDOWN_MS) continue;

    if (dryRun) {
      log(`autocommit [dry] WOULD commit ${scope.label}: ${verdict.reason}`);
      fired++;
      continue;
    }
    lastAttempt.set(scope.label, Date.now());
    try {
      const res = await callEndSession(cfg, scope);
      if (res.ok) {
        fired++;
        log(
          `autocommit: committed ${scope.label} (${verdict.reason}) -> ` +
            `${res.body?.archived ? `archived ${res.body.vaultPath} (${res.body.messageCount} msgs)` : `no archive (${res.body?.reason})`}`
        );
      } else {
        log(`autocommit: end-session refused for ${scope.label}: ${JSON.stringify(res.body).slice(0, 200)}`);
      }
    } catch (err) {
      log(`autocommit: app unreachable for ${scope.label} (${err.message}) - will retry after cooldown`);
    }
  }
  return { scopes: scopes.length, fired, verdicts };
}
