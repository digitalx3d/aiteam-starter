import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sessionLogPath } from "./session-log";

/**
 * Warm Worker Pool — Phase 1 (session reuse).
 *
 * Keeps ONE durable Claude Code session per (agent, project) so dispatch can
 * `--resume` it instead of spinning a fresh session every time. Benefits:
 *   - Warm prompt cache when dispatches to the same pair land within ~5 min
 *     (cheaper + faster first token — the sliding-window cache stays hot).
 *   - The persona is baked in at creation, so resumes skip re-injecting it.
 *   - The agent keeps its prior project context across dispatches (continuity).
 *
 * Recycling: when a reused session's on-disk log grows past a threshold, it's
 * marked `retire`. The next claim drops it and starts fresh (persona re-injected).
 * A worker's durable memory is its own persona + completed.md files, so a fresh
 * start isn't amnesiac. (A per-agent distilled primer is future work — the
 * existing distiller is CVB-shaped, not worker-shaped.)
 *
 * Fail-safe by construction: any error path returns an untracked fresh session,
 * so a broken pool degrades to today's behavior (always-fresh) rather than
 * breaking dispatch. All internals are synchronous fs so each claim/release runs
 * atomically in a single tick (no await between the busy check and the set).
 */

// ~60% of a 200k-context worker. jsonl bytes/4 over-estimates tokens (json
// overhead), so this trips a bit early — recycling early is safe.
const RETIRE_THRESHOLD_TOKENS = 120_000;

const WARM_DIR = path.join(process.cwd(), ".warm-pool");
const LOG_PATH = path.join(WARM_DIR, "recycle.log");

export interface WarmSession {
  key: string;
  agent: string;
  project: string | null;
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
  /** Dispatches served on this session so far. */
  turns: number;
  /** Rough running token estimate from the on-disk session log (bytes/4). */
  tokensEstimate: number;
  /** A dispatch is currently running on this session (no second process may share it). */
  busy: boolean;
  /** Marked full — the next claim recycles it into a fresh session. */
  retire: boolean;
}

export interface WarmClaim {
  sessionId: string;
  /** true → spawn with --resume; false → create fresh with the persona injected. */
  resume: boolean;
  /** true → release() should update the registry when the dispatch finishes. */
  tracked: boolean;
  /** Registry key, or null on the fail-safe path. */
  key: string | null;
  /** Set when this claim recycled a retired session whose log still exists —
   *  the caller should distill it into a worker primer (if not already done). */
  recycled: { sessionId: string } | null;
}

export interface WarmRelease {
  /** true when THIS release crossed the fullness threshold and marked retire —
   *  the caller should distill the session into a worker primer now, so the
   *  primer is ready before the next dispatch recycles the pair. */
  retiredNow: boolean;
  sessionId: string | null;
}

const store = new Map<string, WarmSession>();
let loaded = false;

function keyOf(agent: string, project: string | null): string {
  return `${agent}::${project ?? "_aiteam"}`;
}

function fileFor(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(WARM_DIR, `${safe}.json`);
}

function ensureLoaded(): void {
  if (loaded) return;
  try {
    const entries = readdirSync(WARM_DIR);
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          readFileSync(path.join(WARM_DIR, f), "utf8")
        ) as WarmSession;
        if (rec && typeof rec.key === "string") {
          // A busy flag left true from a crashed process would wedge the pair
          // forever. On load, clear it — nothing can still be running after a
          // restart of this process.
          rec.busy = false;
          store.set(rec.key, rec);
        }
      } catch {
        /* skip malformed record */
      }
    }
  } catch {
    /* dir doesn't exist yet — first run */
  }
  loaded = true;
}

function persist(rec: WarmSession): void {
  try {
    mkdirSync(WARM_DIR, { recursive: true });
    writeFileSync(fileFor(rec.key), JSON.stringify(rec, null, 2), "utf8");
  } catch {
    /* best-effort — the in-memory map is the source of truth for this process */
  }
}

function logLine(msg: string): void {
  try {
    mkdirSync(WARM_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

/** True if the session's Claude Code log still exists on disk (safe to --resume). */
function sessionLogExists(cwd: string, sessionId: string): boolean {
  try {
    return existsSync(sessionLogPath(cwd, sessionId));
  } catch {
    return false;
  }
}

function sessionLogBytes(cwd: string, sessionId: string): number {
  try {
    return statSync(sessionLogPath(cwd, sessionId)).size;
  } catch {
    return 0;
  }
}

/**
 * Claim a session for a dispatch. Returns the sessionId to spawn with and whether
 * to resume. Marks the warm session busy so a concurrent dispatch to the same
 * pair falls back to an untracked throwaway session (two processes must never
 * share one session).
 *
 * NOTE: no `await` in this body — it runs atomically, so the busy check-and-set
 * can't interleave with a concurrent claim.
 */
export async function claimWarmSession(
  agent: string,
  project: string | null,
  cwd: string
): Promise<WarmClaim> {
  let key: string | null = null;
  try {
    ensureLoaded();
    key = keyOf(agent, project);
    const rec = store.get(key);

    // Reuse: healthy, idle, not retired, and its log still exists.
    if (
      rec &&
      !rec.busy &&
      !rec.retire &&
      sessionLogExists(cwd, rec.sessionId)
    ) {
      rec.busy = true;
      persist(rec);
      return { sessionId: rec.sessionId, resume: true, tracked: true, key, recycled: null };
    }

    // Busy: another dispatch owns this pair right now → untracked fresh session.
    if (rec && rec.busy) {
      return {
        sessionId: randomUUID(),
        resume: false,
        tracked: false,
        key,
        recycled: null,
      };
    }

    // Recycle a retired (full) session, or replace one whose log vanished.
    let recycled: WarmClaim["recycled"] = null;
    if (rec && rec.retire) {
      logLine(
        `recycle ${key} (session ${rec.sessionId}, ~${rec.tokensEstimate} tok, ${rec.turns} turns)`
      );
      if (sessionLogExists(cwd, rec.sessionId)) {
        recycled = { sessionId: rec.sessionId };
      }
    }

    const sessionId = randomUUID();
    const fresh: WarmSession = {
      key,
      agent,
      project,
      sessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      turns: 0,
      tokensEstimate: 0,
      busy: true,
      retire: false,
    };
    store.set(key, fresh);
    persist(fresh);
    return { sessionId, resume: false, tracked: true, key, recycled };
  } catch {
    // Fail-safe: behave like today (always-fresh, untracked).
    return { sessionId: randomUUID(), resume: false, tracked: false, key, recycled: null };
  }
}

/**
 * Release a warm session when its dispatch finishes: clear busy, bump usage, and
 * re-measure the on-disk log to update the fullness estimate (marking it for
 * recycle if it crossed the threshold). No-op for untracked claims.
 */
export async function releaseWarmSession(
  key: string,
  opts: { cwd: string }
): Promise<WarmRelease> {
  try {
    ensureLoaded();
    const rec = store.get(key);
    if (!rec) return { retiredNow: false, sessionId: null };
    rec.busy = false;
    rec.lastUsedAt = Date.now();
    rec.turns += 1;
    const bytes = sessionLogBytes(opts.cwd, rec.sessionId);
    if (bytes > 0) rec.tokensEstimate = Math.round(bytes / 4);
    const wasRetired = rec.retire;
    if (rec.tokensEstimate >= RETIRE_THRESHOLD_TOKENS) rec.retire = true;
    persist(rec);
    return {
      retiredNow: rec.retire && !wasRetired,
      sessionId: rec.sessionId,
    };
  } catch {
    /* best-effort — never break the dispatch completion path */
    return { retiredNow: false, sessionId: null };
  }
}

/** Read-only peek at a pair's warm session (for future status display). */
export async function getWarmSession(
  agent: string,
  project: string | null
): Promise<WarmSession | null> {
  try {
    ensureLoaded();
    return store.get(keyOf(agent, project)) ?? null;
  } catch {
    return null;
  }
}
