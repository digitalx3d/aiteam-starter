import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig, SETTINGS_FILE } from "./config";
import { encodeCwdForClaude, costForUsage, type UsageBlock } from "./project-costs";
import { readAllTickets } from "./dispatch-ticket-cache";

/**
 * Persistent, accumulating per-project statistics: spend, tokens, and time.
 *
 * WHY THIS EXISTS AS A STORE RATHER THAN A LIVE CALCULATION
 *
 * Two independent problems rule out computing this on demand:
 *
 *   1. Volume. The transcript archive is ~460 MB across ~1,200 .jsonl files.
 *      Re-reading it costs 0.5-2s per project — fine for one project page, far
 *      too slow for a 25-row list.
 *
 *   2. Deletion. Claude Code deletes transcripts after 30 days
 *      (cleanupPeriodDays, default 30, not overridden in ~/.claude/settings.json).
 *      So the raw data is a ROLLING 30-DAY WINDOW, not a history. Anything
 *      computed live silently resets as files age out — a project's lifetime
 *      total would drift downward over time and never be recoverable.
 *
 * The fix for both is the same: record each transcript's contribution once, keyed
 * by file path, and keep that record after the file itself is deleted. The file
 * map IS the source of truth; aggregates are re-summed from it on read, so there
 * is no incremental add/subtract to drift out of sync.
 *
 * A file is re-parsed only when its mtime or size changes, which makes a refresh
 * after the first build nearly free.
 */

/** Gaps longer than this are treated as "walked away" and not counted as time worked. */
const IDLE_CAP_MS = 15 * 60_000;

/** A session must last this long AND carry this many of the owner's messages to count as
 *  his time. Filters out automated background runs — heartbeats, pollers, distill
 *  calls — which dominate by count (392 of aiTeam's 440 sessions are under 2 min)
 *  but are not work he did. Agent runs are exempt; they're legitimately agent time. */
const REAL_SESSION_MIN_MS = 2 * 60_000;
const REAL_SESSION_MIN_USER_MSGS = 2;

const STORE_VERSION = 2;

export interface DailyBucket {
  cost: number;
  youMs: number;
  agentMs: number;
}

/** One transcript's recorded contribution. Survives deletion of the file. */
interface FileContribution {
  mtimeMs: number;
  size: number;
  cost: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  youMs: number;
  agentMs: number;
  /** true once the source transcript has aged out of ~/.claude/projects */
  gone?: boolean;
  daily: Record<string, DailyBucket>;
  /** dispatched worker run (or Task-tool subagent) rather than one of the owner's sessions */
  agent: boolean;
}

interface ProjectRecord {
  files: Record<string, FileContribution>;
  /** One-time engaged-time backfill from ~/.claude/history.jsonl, covering the
   *  period before this project's transcripts begin. Milliseconds. */
  backfillMs?: number;
}

interface StoreFile {
  version: number;
  updatedAt: string;
  /** Set once the history.jsonl backfill has run, so it never double-counts. */
  backfill?: { doneAt: string; cutoffIso: string };
  projects: Record<string, ProjectRecord>;
}

export interface ProjectStats {
  cost: { chat: number; agents: number; total: number };
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  /** Engaged time in milliseconds. `you` includes the one-time history backfill. */
  timeMs: { you: number; agents: number };
  /** YYYY-MM-DD -> bucket, for the sparkline. Local dates, not UTC. */
  daily: Record<string, DailyBucket>;
  /** Earliest activity we have any record of, ISO date, or null if unknown. */
  since: string | null;
}

/** Lives next to settings.json in ~/.aiteam/, the per-machine runtime-state home
 *  (alongside hidden-projects.json). Deliberately NOT inside
 *  getConfig().aiteamDir — that points at the aiTeam repo, and this is generated
 *  runtime data that must never be committed or shared between machines. */
function storePath(): string {
  return path.join(path.dirname(SETTINGS_FILE), "project-stats.json");
}

function emptyStore(): StoreFile {
  return { version: STORE_VERSION, updatedAt: new Date(0).toISOString(), projects: {} };
}

async function readStore(): Promise<StoreFile> {
  try {
    const raw = await fsp.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    // A version bump means the contribution shape changed; rebuild from scratch
    // rather than mixing incompatible records. Only costs one slow refresh.
    if (parsed.version !== STORE_VERSION || !parsed.projects) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  const target = storePath();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a truncated store behind.
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(store), "utf8");
  await fsp.rename(tmp, target);
}

/** Local YYYY-MM-DD. Sparkline days should match the days the owner lived, not UTC. */
function localDay(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function addDaily(target: Record<string, DailyBucket>, day: string, patch: Partial<DailyBucket>): void {
  const b = (target[day] ??= { cost: 0, youMs: 0, agentMs: 0 });
  b.cost += patch.cost ?? 0;
  b.youMs += patch.youMs ?? 0;
  b.agentMs += patch.agentMs ?? 0;
}

/** Session IDs of dispatched worker runs. See project-costs.ts for why this is
 *  needed: dispatch.mjs runs workers as top-level processes in the project cwd,
 *  so their transcripts are indistinguishable from the owner's by path alone. */
async function dispatchedSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const t of await readAllTickets()) {
    if (typeof t.sessionId === "string" && t.sessionId) ids.add(t.sessionId);
  }
  return ids;
}

/**
 * Parse one transcript into a contribution record.
 *
 * Cost/tokens dedupe by message id — a single assistant turn is written as several
 * lines sharing one id, each carrying the same complete usage block (verified: 175
 * multi-line ids in a sample file, all identical), so counting lines would inflate
 * the total roughly 2.7x.
 *
 * Time sums the gaps between consecutive timestamps, skipping any gap over the
 * idle cap. This measures engagement, not presence: reading output without typing
 * isn't captured, so the figure is a conservative floor.
 */
async function parseTranscript(
  fp: string,
  mtimeMs: number,
  size: number,
  isAgent: boolean
): Promise<FileContribution> {
  const raw = await fsp.readFile(fp, "utf8");
  const perMessage = new Map<string, { model: string; usage: UsageBlock; ms: number }>();
  const stamps: number[] = [];
  let userMsgs = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: {
      type?: string;
      timestamp?: string;
      message?: { id?: string; model?: string; usage?: UsageBlock };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "user") userMsgs++;
    const ms = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (Number.isFinite(ms)) stamps.push(ms);
    const msg = obj.message;
    if (msg && typeof msg === "object" && msg.id && msg.usage) {
      perMessage.set(msg.id, {
        model: msg.model ?? "",
        usage: msg.usage,
        ms: Number.isFinite(ms) ? ms : 0,
      });
    }
  }

  const c: FileContribution = {
    mtimeMs,
    size,
    cost: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    youMs: 0,
    agentMs: 0,
    daily: {},
    agent: isAgent,
  };

  for (const { model, usage, ms } of perMessage.values()) {
    const cost = costForUsage(usage, model);
    c.cost += cost;
    c.input += usage.input_tokens ?? 0;
    c.output += usage.output_tokens ?? 0;
    c.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    c.cacheRead += usage.cache_read_input_tokens ?? 0;
    if (ms) addDaily(c.daily, localDay(ms), { cost });
  }

  if (stamps.length >= 2) {
    stamps.sort((a, b) => a - b);
    const span = stamps[stamps.length - 1] - stamps[0];
    // Automated background sessions are machine noise, not work the owner did.
    const counts =
      isAgent || (span >= REAL_SESSION_MIN_MS && userMsgs >= REAL_SESSION_MIN_USER_MSGS);
    if (counts) {
      for (let i = 1; i < stamps.length; i++) {
        const gap = stamps[i] - stamps[i - 1];
        if (gap <= 0 || gap > IDLE_CAP_MS) continue;
        if (isAgent) c.agentMs += gap;
        else c.youMs += gap;
        addDaily(c.daily, localDay(stamps[i - 1]), isAgent ? { agentMs: gap } : { youMs: gap });
      }
    }
  }

  return c;
}

/** Walk a project's transcript folder, returning every .jsonl with its stat info. */
async function listTranscripts(
  dir: string,
  depth: number,
  out: { fp: string; mtimeMs: number; size: number; depth: number }[]
): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // In parallel: one at a time, thousands of stats queue up behind each other.
  await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await listTranscripts(full, depth + 1, out);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = await fsp.stat(full);
          out.push({ fp: full, mtimeMs: st.mtimeMs, size: st.size, depth });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    })
  );
}

function aggregate(rec: ProjectRecord): ProjectStats {
  const stats: ProjectStats = {
    cost: { chat: 0, agents: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    timeMs: { you: rec.backfillMs ?? 0, agents: 0 },
    daily: {},
    since: null,
  };
  for (const c of Object.values(rec.files)) {
    if (c.agent) stats.cost.agents += c.cost;
    else stats.cost.chat += c.cost;
    stats.tokens.input += c.input;
    stats.tokens.output += c.output;
    stats.tokens.cacheWrite += c.cacheWrite;
    stats.tokens.cacheRead += c.cacheRead;
    stats.timeMs.you += c.youMs;
    stats.timeMs.agents += c.agentMs;
    for (const [day, b] of Object.entries(c.daily)) {
      addDaily(stats.daily, day, b);
      if (!stats.since || day < stats.since) stats.since = day;
    }
  }
  stats.cost.total = stats.cost.chat + stats.cost.agents;
  return stats;
}

/**
 * One-time backfill of engaged time from ~/.claude/history.jsonl.
 *
 * That file records every prompt the owner has sent (project path +
 * timestamp, no token data) and is NOT subject to the 30-day transcript cleanup.
 * It's the only surviving record of activity before the transcript window opens.
 *
 * Cost cannot be backfilled — token counts existed only inside the deleted
 * transcripts, and nothing else ever recorded them.
 *
 * Only prompts strictly older than the project's earliest transcript day are
 * counted, so this can never double-count against live data. Runs once; the
 * marker in the store prevents a second pass.
 */
async function runHistoryBackfill(store: StoreFile, slugByFolderKey: Map<string, string>): Promise<boolean> {
  if (store.backfill) return false;
  const historyPath = path.join(path.dirname(getConfig().claudeProjectsDir), "history.jsonl");
  let raw: string;
  try {
    raw = await fsp.readFile(historyPath, "utf8");
  } catch {
    return false;
  }

  // Earliest day we already have real transcript data for, per project. Prompts
  // at or after this are already represented and must not be added again.
  const cutoff = new Map<string, number>();
  for (const [slug, rec] of Object.entries(store.projects)) {
    let earliest = Infinity;
    for (const c of Object.values(rec.files)) {
      for (const day of Object.keys(c.daily)) {
        const ms = Date.parse(`${day}T00:00:00`);
        if (Number.isFinite(ms)) earliest = Math.min(earliest, ms);
      }
    }
    if (Number.isFinite(earliest)) cutoff.set(slug, earliest);
  }

  const bySlug = new Map<string, number[]>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o: { project?: unknown; timestamp?: unknown };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.project !== "string" || typeof o.timestamp !== "number") continue;
    // history.jsonl stores the full cwd with inconsistent casing
    // ("C:\Code\aiTeam" vs "C:\code\bakerysite"), so match on the
    // lowercased folder name rather than the path.
    const folder = o.project.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (!folder) continue;
    const slug = slugByFolderKey.get(folder.toLowerCase());
    if (!slug) continue;
    const limit = cutoff.get(slug);
    if (limit !== undefined && o.timestamp >= limit) continue;
    (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug)!).push(o.timestamp);
  }

  for (const [slug, stamps] of bySlug) {
    if (stamps.length < 2) continue;
    stamps.sort((a, b) => a - b);
    let ms = 0;
    for (let i = 1; i < stamps.length; i++) {
      const gap = stamps[i] - stamps[i - 1];
      if (gap > 0 && gap <= IDLE_CAP_MS) ms += gap;
    }
    if (ms <= 0) continue;
    const rec = (store.projects[slug] ??= { files: {} });
    rec.backfillMs = (rec.backfillMs ?? 0) + ms;
  }

  store.backfill = { doneAt: new Date().toISOString(), cutoffIso: new Date().toISOString() };
  return true;
}

let inFlight: Promise<StoreFile> | null = null;

/**
 * Bring the store up to date: parse any new or changed transcript, keep the
 * recorded contribution of any that have been deleted, and run the one-time
 * history backfill. Concurrent callers share a single refresh.
 */
async function refresh(slugs: { slug: string; cwd: string }[]): Promise<StoreFile> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const store = await readStore();
    const dispatched = await dispatchedSessionIds();
    let dirty = false;

    for (const { slug, cwd } of slugs) {
      const rec = (store.projects[slug] ??= { files: {} });
      const dir = path.join(getConfig().claudeProjectsDir, encodeCwdForClaude(cwd));
      const found: { fp: string; mtimeMs: number; size: number; depth: number }[] = [];
      await listTranscripts(dir, 0, found);

      const seen = new Set<string>();
      for (const f of found) {
        seen.add(f.fp);
        const prev = rec.files[f.fp];
        // Unchanged since last pass — its contribution is already recorded.
        if (prev && !prev.gone && prev.mtimeMs === f.mtimeMs && prev.size === f.size) continue;
        const isAgent =
          f.depth > 0 || dispatched.has(path.basename(f.fp).slice(0, -".jsonl".length));
        try {
          rec.files[f.fp] = await parseTranscript(f.fp, f.mtimeMs, f.size, isAgent);
          dirty = true;
        } catch {
          /* unreadable — leave any previous contribution intact */
        }
      }

      // Deleted by the 30-day cleanup. Keep the contribution (that is the whole
      // point of the store) and flag it so we stop looking for the file.
      for (const [fp, c] of Object.entries(rec.files)) {
        if (!seen.has(fp) && !c.gone) {
          c.gone = true;
          dirty = true;
        }
      }
    }

    const slugByFolderKey = new Map<string, string>();
    for (const { slug, cwd } of slugs) {
      slugByFolderKey.set(path.basename(cwd).toLowerCase(), slug);
    }
    if (await runHistoryBackfill(store, slugByFolderKey)) dirty = true;

    if (dirty) {
      store.updatedAt = new Date().toISOString();
      await writeStore(store);
    }
    return store;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Up-to-date stats for the given projects, keyed by slug. */
export async function getProjectStats(
  projects: { slug: string; cwd: string }[]
): Promise<Record<string, ProjectStats>> {
  const store = await refresh(projects);
  const out: Record<string, ProjectStats> = {};
  for (const { slug } of projects) {
    const rec = store.projects[slug];
    out[slug] = rec
      ? aggregate(rec)
      : {
          cost: { chat: 0, agents: 0, total: 0 },
          tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
          timeMs: { you: 0, agents: 0 },
          daily: {},
          since: null,
        };
  }
  return out;
}

/** Earliest day any project has data for — drives the cost column tooltip. */
export function earliestDay(all: Record<string, ProjectStats>): string | null {
  let earliest: string | null = null;
  for (const s of Object.values(all)) {
    if (s.since && (!earliest || s.since < earliest)) earliest = s.since;
  }
  return earliest;
}
