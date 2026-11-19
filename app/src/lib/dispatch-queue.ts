import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/*
 * dispatch-queue.ts: the waiting line behind `dispatch.mjs --after <ticket>`.
 *
 * A queued job is a dispatch that starts by itself when the ticket it waits on
 * finishes successfully. If that ticket fails, is cancelled, or the worker's last
 * Live Feed post was a blocker, the chain stops: the job turns "blocked" (shown as
 * "waiting on a failed job") and never starts on its own. A cover is never
 * uploaded off copy that never arrived.
 *
 * Built to be easy to undo (docs/dispatch-queue.md, "How to undo"). Hence:
 *   - Everything lives in ONE file of its own (~/.aiteam/dispatch-queue.json).
 *     Ticket files never change shape; a released job simply becomes an ordinary
 *     ticket whose id is the id the queue handed out. Removing the feature leaves
 *     nothing behind but this file, which can be deleted.
 *   - The off switch (settings.json "dispatchQueue": false) is checked by the
 *     caller; when off, nothing is queued and nothing waiting is started.
 *
 * More than one dashboard process may share this file. Every
 * read-modify-write happens under an exclusive lock file and is synchronous end
 * to end, so a job is claimed for release exactly once. The ticket store adds a
 * second guard: a released job's ticket file is created exclusively, so even a
 * broken lock cannot start the same job twice.
 *
 * This module only decides. It imports nothing from the app (so node's test
 * runner can load it directly); the caller does the spawning, board updates and
 * chat posts (dispatch-queue-effects.ts and api/dispatch/route.ts).
 */

/** Most jobs that may be waiting at once, across every project. */
export const MAX_WAITING = 10;

/** A lock older than this was left by a process that died holding it. Real
 *  holds last milliseconds: every critical section is synchronous file I/O. */
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

/** Finished entries (released, cancelled) stay listed this long, then go. */
const KEEP_ENDED_MS = 24 * 60 * 60 * 1000;
/** "This worker reported blocked" notes are kept this long. */
const KEEP_BLOCKED_REPORT_MS = 7 * 24 * 60 * 60 * 1000;

/** Usage limit: wait this long past the advertised reset before re-running. */
export const LIMIT_GRACE_MS = 2 * 60 * 1000;
/** Re-runs per waiting job before a limit counts as a plain failure. */
export const MAX_LIMIT_RERUNS = 2;
/** A re-run ticket the queue asked for but that never appeared is given up on. */
const RERUN_START_MS = 5 * 60 * 1000;

export type QueueState =
  /** Waiting for its predecessor to finish. */
  | "waiting"
  /** The predecessor failed, was cancelled, or reported blocked. Never starts
   *  on its own; stays listed and cancellable. */
  | "blocked"
  /** Started: an ordinary ticket with this id now exists. */
  | "released"
  /** Removed with --cancel before it started. */
  | "cancelled"
  /** The predecessor died on the usage limit. At holdUntil the queue re-runs
   *  that predecessor once and this job goes back to waiting behind the re-run. */
  | "held";

export interface QueuedDispatch {
  /** Handed back to the caller at once. Becomes the ticket id on release, so a
   *  chain (C after B, B after A) can name B before B has started. */
  id: string;
  /** The ticket (or queued job) this one waits on. Full id. */
  after: string;
  agent: string;
  project: string | null;
  brief: string;
  model: string | null;
  effort: string | null;
  securityReview: boolean;
  /** Board task created at queue time, flipped to in-progress on release. */
  taskId: string | null;
  /** The queue created that task (so cancelling removes it), rather than CVB
   *  passing an existing one in. */
  taskOwned: boolean;
  createdAt: number;
  state: QueueState;
  /** Why it is blocked, in plain words. */
  reason: string | null;
  /** The "waiting on a failed job" report has been posted to the chat. */
  notified: boolean;
  releasedAt: number | null;
  /** When it was released or cancelled; ended entries are pruned after a day. */
  endedAt: number | null;
  /** Held for the usage limit until this time (reset plus a short grace). */
  holdUntil?: number | null;
  /** How many times a dead predecessor of this job has been re-run. */
  limitReruns?: number;
}

interface QueueData {
  version: 1;
  jobs: QueuedDispatch[];
  /** Tickets that finished cleanly but whose worker's last Live Feed post was a
   *  blocker: ticket id -> reason. Ticket files don't carry this, by design. */
  blockedReports: Record<string, { reason: string; at: number }>;
  /** Re-runs the queue started for predecessors that died on the usage limit:
   *  new ticket id -> the ticket it re-runs. One re-run per dead ticket, however
   *  many jobs wait on it. */
  reruns: Record<string, { of: string; at: number }>;
}

/** Where the queue and the ticket store live. Injected so tests use a temp dir. */
export interface QueueEnv {
  /** ~/.aiteam/dispatch-queue.json */
  file: string;
  /** app/.dispatches, where ticket files are <id>.json */
  dispatchesDir: string;
  /** Absolute path to scripts/dispatch.mjs, for the commands shown in messages. */
  dispatchScript?: string;
}

export const ACTIVE_STATES: QueueState[] = ["waiting", "blocked", "held"];

export function isActive(job: QueuedDispatch): boolean {
  return ACTIVE_STATES.includes(job.state);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// File I/O under the lock
// ---------------------------------------------------------------------------

/** Windows reports a file that another process is deleting or renaming as
 *  EPERM/EBUSY/EACCES rather than EEXIST. All of them mean "busy, try again". */
function isBusy(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(env: QueueEnv, fn: () => T): T {
  fs.mkdirSync(path.dirname(env.file), { recursive: true });
  const lock = env.file + ".lock";
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (err) {
      if (!isBusy(err)) throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // the holder let go between our open and our stat
      }
      if (Date.now() > deadline) {
        throw new Error("the dispatch queue is busy (lock held by another process)");
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

function emptyData(): QueueData {
  return { version: 1, jobs: [], blockedReports: {}, reruns: {} };
}

function readData(env: QueueEnv): QueueData {
  let raw: string;
  try {
    raw = fs.readFileSync(env.file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
    throw err;
  }
  // A malformed file is an error, not an empty queue: treating it as empty
  // would let the next write erase every waiting job.
  const parsed = JSON.parse(raw) as Partial<QueueData>;
  return {
    version: 1,
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    blockedReports:
      parsed.blockedReports && typeof parsed.blockedReports === "object"
        ? parsed.blockedReports
        : {},
    reruns: parsed.reruns && typeof parsed.reruns === "object" ? parsed.reruns : {},
  };
}

function prune(data: QueueData, now: number): void {
  data.jobs = data.jobs.filter(
    (j) => isActive(j) || j.endedAt === null || now - j.endedAt < KEEP_ENDED_MS
  );
  for (const [id, r] of Object.entries(data.blockedReports)) {
    if (now - r.at > KEEP_BLOCKED_REPORT_MS) delete data.blockedReports[id];
  }
  for (const [id, r] of Object.entries(data.reruns)) {
    if (now - r.at > KEEP_BLOCKED_REPORT_MS) delete data.reruns[id];
  }
}

function writeData(env: QueueEnv, data: QueueData, now: number): void {
  prune(data, now);
  const tmp = `${env.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  // A reader outside the lock (the list API) can hold the file open for a
  // moment, which on Windows makes the rename fail with EPERM. Retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, env.file);
      return;
    } catch (err) {
      if (!isBusy(err) || attempt >= 50) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw err;
      }
      sleepSync(10);
    }
  }
}

// ---------------------------------------------------------------------------
// Tickets, read straight from disk (never from a process's in-memory cache:
// the other dashboard process may have written them)
// ---------------------------------------------------------------------------

export interface TicketView {
  id: string;
  agent: string;
  status: string;
  errorMessage: string | null;
  finishedAt: number | null;
}

export function readTicket(env: QueueEnv, id: string): TicketView | null {
  if (!/^[0-9a-f-]{8,36}$/i.test(id)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(env.dispatchesDir, `${id}.json`), "utf8"));
    if (!t || typeof t.id !== "string") return null;
    return {
      id: t.id,
      agent: String(t.agent ?? "worker"),
      status: String(t.status ?? ""),
      errorMessage: typeof t.errorMessage === "string" ? t.errorMessage : null,
      finishedAt: typeof t.finishedAt === "number" ? t.finishedAt : null,
    };
  } catch {
    return null;
  }
}

/** Full id for a ticket or queued job named by its full id or a unique prefix
 *  of at least 8 characters (the chat shows 8). */
function resolveId(
  env: QueueEnv,
  data: QueueData,
  given: string
): { id: string } | { error: string } {
  const want = given.trim().toLowerCase();
  if (!/^[0-9a-f-]{8,36}$/.test(want)) {
    return { error: `"${given}" is not a ticket id (expected the id dispatch.mjs printed, or its first 8 characters)` };
  }
  const hits = new Set<string>();
  for (const j of data.jobs) if (j.id.startsWith(want)) hits.add(j.id);
  if (want.length === 36) {
    if (readTicket(env, want)) hits.add(want);
  } else {
    try {
      for (const f of fs.readdirSync(env.dispatchesDir)) {
        if (f.endsWith(".json") && f.startsWith(want)) hits.add(f.slice(0, -5));
      }
    } catch {
      /* no tickets yet */
    }
  }
  if (hits.size === 0) return { error: `no ticket or queued job ${given}` };
  if (hits.size > 1) return { error: `${given} matches ${hits.size} tickets; give more of the id` };
  return { id: [...hits][0] };
}

// ---------------------------------------------------------------------------
// What is the predecessor doing?
// ---------------------------------------------------------------------------

export type PredecessorState =
  | { kind: "pending" }
  | { kind: "done" }
  | { kind: "failed"; reason: string }
  /** Died on the usage limit; resetAt is when the limit lifts. */
  | { kind: "limit"; reason: string; resetAt: number };

export function predecessorState(
  env: QueueEnv,
  data: QueueData,
  afterId: string,
  now = Date.now()
): PredecessorState {
  const t = readTicket(env, afterId);
  if (t) {
    const who = `${t.agent}'s job ${shortId(t.id)}`;
    switch (t.status) {
      case "done": {
        const blocked = data.blockedReports[t.id];
        return blocked ? { kind: "failed", reason: `${who} reported blocked (${blocked.reason})` } : { kind: "done" };
      }
      case "failed": {
        const resetAt = t.errorMessage ? parseLimitReset(t.errorMessage, t.finishedAt ?? Date.now()) : null;
        if (resetAt !== null) {
          return { kind: "limit", resetAt, reason: `${who} stopped at the usage limit (${t.errorMessage})` };
        }
        return { kind: "failed", reason: `${who} failed: ${t.errorMessage ?? "no reason recorded"}` };
      }
      case "cancelled":
        return { kind: "failed", reason: `${who} was cancelled` };
      default:
        return { kind: "pending" }; // queued or running
    }
  }
  const prev = data.jobs.find((j) => j.id === afterId);
  if (prev) {
    const who = `${prev.agent}'s queued job ${shortId(prev.id)}`;
    switch (prev.state) {
      case "waiting":
      case "held":
      case "released": // its ticket file is being written right now
        return { kind: "pending" };
      case "blocked":
        return { kind: "failed", reason: `${who} is itself waiting on a failed job` };
      case "cancelled":
        return { kind: "failed", reason: `${who} was cancelled` };
    }
  }
  const rerun = data.reruns[afterId];
  if (rerun) {
    // The queue asked for this re-run; its ticket is being created.
    if (now - rerun.at < RERUN_START_MS) return { kind: "pending" };
    return { kind: "failed", reason: `the re-run of ${shortId(rerun.of)} after the usage limit never started` };
  }
  return { kind: "failed", reason: `ticket ${shortId(afterId)} no longer exists` };
}

// ---------------------------------------------------------------------------
// The usage limit: "You've hit your session limit, resets 10:10pm (America/New_York)"
// ---------------------------------------------------------------------------

const LIMIT_RE = /\blimit\b[^\n]*?\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i;

/** Wall-clock date of an instant in a time zone (the server's own if tz is
 *  undefined), plus that zone's offset from UTC at that instant. */
function zoned(ms: number, tz: string | undefined) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const wall = Date.UTC(y, mo - 1, d, Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return { y, mo, d, offset: wall - Math.floor(ms / 1000) * 1000 };
}

/**
 * When a usage-limit failure lifts: the next occurrence of the advertised wall
 * time, in the advertised zone, after the job died. Null if the message is not
 * a usage-limit failure (or names no time this can read), so it counts as an
 * ordinary failure and stops the chain.
 */
export function parseLimitReset(message: string, failedAt: number): number | null {
  const m = LIMIT_RE.exec(message);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  const minute = m[2] ? Number(m[2]) : 0;
  if (Number(m[1]) > 12 || minute > 59) return null;
  let tz: string | undefined = m[4]?.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = undefined;
  }
  const day = zoned(failedAt, tz);
  const at = (dayOffset: number) => {
    const wall = Date.UTC(day.y, day.mo - 1, day.d + dayOffset, hour, minute);
    // Re-check the offset at the target instant, in case a clock change sits between.
    return wall - zoned(wall - day.offset, tz).offset;
  };
  let reset = at(0);
  // A reset well before the failure is tomorrow's (10pm failure, "resets 12:40am").
  if (reset < failedAt - 30 * 60 * 1000) reset = at(1);
  return reset;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  id: string;
  after: string;
  agent: string;
  project: string | null;
  brief: string;
  model: string | null;
  effort: string | null;
  securityReview: boolean;
  taskId: string | null;
  taskOwned: boolean;
}

export type EnqueueCheck =
  | { ok: true; after: string; predecessorAgent: string }
  | { ok: false; error: string };

/** The refusals, without writing anything. The caller checks first, creates
 *  the board task, then enqueues (which checks again under the lock). */
export function checkEnqueue(env: QueueEnv, after: string): EnqueueCheck {
  return withLock(env, () => checkLocked(env, readData(env), after));
}

function checkLocked(env: QueueEnv, data: QueueData, after: string): EnqueueCheck {
  const active = data.jobs.filter(isActive).length;
  if (active >= MAX_WAITING) {
    return {
      ok: false,
      error:
        `the queue is full: ${active} jobs are already waiting (the limit is ${MAX_WAITING}). ` +
        `Let some start, or remove one with: node ${env.dispatchScript ?? "scripts/dispatch.mjs"} --cancel <ticketId>`,
    };
  }
  const resolved = resolveId(env, data, after);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const state = predecessorState(env, data, resolved.id);
  // A predecessor that died on the usage limit is still worth waiting on: the
  // queue re-runs it after the reset (see planSweep).
  if (state.kind === "failed") {
    return {
      ok: false,
      error: `nothing to wait for: ${state.reason}. Dispatch without --after, or re-run that job first.`,
    };
  }
  const t = readTicket(env, resolved.id);
  const q = data.jobs.find((j) => j.id === resolved.id);
  return { ok: true, after: resolved.id, predecessorAgent: t?.agent ?? q?.agent ?? "worker" };
}

export function enqueue(
  env: QueueEnv,
  input: EnqueueInput,
  now = Date.now()
): { ok: true; job: QueuedDispatch } | { ok: false; error: string } {
  return withLock(env, () => {
    const data = readData(env);
    const check = checkLocked(env, data, input.after);
    if (!check.ok) return check;
    const job: QueuedDispatch = {
      ...input,
      after: check.after,
      createdAt: now,
      state: "waiting",
      reason: null,
      notified: false,
      releasedAt: null,
      endedAt: null,
    };
    data.jobs.push(job);
    writeData(env, data, now);
    return { ok: true, job };
  });
}

export function cancel(
  env: QueueEnv,
  given: string,
  now = Date.now()
): { ok: true; job: QueuedDispatch } | { ok: false; error: string; notFound?: boolean } {
  return withLock(env, () => {
    const data = readData(env);
    const want = given.trim().toLowerCase();
    const hits = want.length >= 8 ? data.jobs.filter((j) => j.id.startsWith(want)) : [];
    if (hits.length === 0) {
      return {
        ok: false,
        notFound: true,
        error: `${given} is not a queued job. Only a job still waiting can be cancelled this way; a running worker is stopped from the Agents tab.`,
      };
    }
    if (hits.length > 1) return { ok: false, error: `${given} matches ${hits.length} queued jobs; give more of the id` };
    const job = hits[0];
    if (job.state === "released") {
      return { ok: false, error: `${shortId(job.id)} has already started; it is a normal running job now (stop it from the Agents tab)` };
    }
    if (job.state === "cancelled") return { ok: false, error: `${shortId(job.id)} was already cancelled` };
    job.state = "cancelled";
    job.endedAt = now;
    job.holdUntil = null;
    writeData(env, data, now);
    return { ok: true, job: { ...job } };
  });
}

/** Record that a ticket finished but its worker reported blocked, so anything
 *  waiting on it stops instead of starting. */
export function recordBlockedReport(env: QueueEnv, ticketId: string, reason: string, now = Date.now()): void {
  withLock(env, () => {
    const data = readData(env);
    data.blockedReports[ticketId] = { reason, at: now };
    writeData(env, data, now);
  });
}

export function setTaskId(env: QueueEnv, id: string, taskId: string | null): void {
  withLock(env, () => {
    const data = readData(env);
    const job = data.jobs.find((j) => j.id === id);
    if (!job) return;
    job.taskId = taskId;
    writeData(env, data, Date.now());
  });
}

/** A release that could not start: park the job as blocked with the reason. */
export function markBlocked(env: QueueEnv, id: string, reason: string, now = Date.now()): void {
  withLock(env, () => {
    const data = readData(env);
    const job = data.jobs.find((j) => j.id === id);
    if (!job) return;
    job.state = "blocked";
    job.reason = reason;
    job.endedAt = null;
    writeData(env, data, now);
  });
}

export function markNotified(env: QueueEnv, ids: string[]): void {
  if (ids.length === 0) return;
  withLock(env, () => {
    const data = readData(env);
    for (const j of data.jobs) if (ids.includes(j.id)) j.notified = true;
    writeData(env, data, Date.now());
  });
}

export function listJobs(env: QueueEnv): QueuedDispatch[] {
  try {
    return readData(env).jobs.map((j) => ({ ...j }));
  } catch {
    return [];
  }
}

export interface SweepPlan {
  /** Claimed for release: already marked "released" in the file. The caller
   *  must start each one with ticket id === job.id. */
  release: QueuedDispatch[];
  /** Newly blocked and not yet reported to the chat. */
  blocked: QueuedDispatch[];
  /** Newly held for the usage limit and not yet reported to the chat. */
  held: QueuedDispatch[];
  /** Dead predecessors to re-run now the limit has lifted: start ticket `of`
   *  again under the new id `id`. The jobs behind it already wait on `id`. */
  rerun: { id: string; of: string }[];
}

/**
 * Walk the waiting jobs once. Anything whose predecessor finished cleanly is
 * claimed (marked released) and returned for the caller to start; anything whose
 * predecessor failed turns blocked. The claim is written before this returns, so
 * a second process sweeping a moment later sees "released" and leaves it alone.
 */
export function planSweep(env: QueueEnv, now = Date.now()): SweepPlan {
  return withLock(env, () => {
    const data = readData(env);
    const plan: SweepPlan = { release: [], blocked: [], held: [], rerun: [] };
    let changed = false;
    // The limit has lifted for these: re-run the dead predecessor (once, however
    // many jobs wait on it) and put them back to waiting behind the re-run.
    for (const job of data.jobs) {
      if (job.state !== "held" || (job.holdUntil ?? 0) > now) continue;
      const dead = job.after;
      let rerunId = Object.keys(data.reruns).find((id) => data.reruns[id].of === dead);
      if (!rerunId) {
        rerunId = randomUUID();
        data.reruns[rerunId] = { of: dead, at: now };
        plan.rerun.push({ id: rerunId, of: dead });
      }
      job.after = rerunId;
      job.state = "waiting";
      job.holdUntil = null;
      job.reason = null;
      job.notified = false;
      job.limitReruns = (job.limitReruns ?? 0) + 1;
      changed = true;
    }
    // Repeat until nothing moves, so a failure cascades down a whole chain in
    // one sweep (A failed, so B is blocked, so C is blocked).
    for (let moved = true; moved; ) {
      moved = false;
      for (const job of data.jobs) {
        if (job.state !== "waiting") continue;
        const p = predecessorState(env, data, job.after, now);
        if (p.kind === "done") {
          job.state = "released";
          job.releasedAt = now;
          job.endedAt = now;
          plan.release.push({ ...job });
          moved = changed = true;
        } else if (p.kind === "failed") {
          job.state = "blocked";
          job.reason = p.reason;
          moved = changed = true;
        } else if (p.kind === "limit") {
          if ((job.limitReruns ?? 0) >= MAX_LIMIT_RERUNS) {
            job.state = "blocked";
            job.reason = `${p.reason}, and the queue already re-ran it ${MAX_LIMIT_RERUNS} times`;
          } else {
            job.state = "held";
            job.holdUntil = p.resetAt + LIMIT_GRACE_MS;
            job.reason = p.reason;
            job.notified = false;
          }
          moved = changed = true;
        }
      }
    }
    for (const job of data.jobs) {
      if (job.state === "blocked" && !job.notified) plan.blocked.push({ ...job });
      if (job.state === "held" && !job.notified) plan.held.push({ ...job });
    }
    if (changed) writeData(env, data, now);
    return plan;
  });
}

/** A re-run the queue asked for could not start: everything waiting on it is
 *  blocked with the reason. Returns the jobs it blocked, for reporting. */
export function blockWaitersOn(env: QueueEnv, afterId: string, reason: string, now = Date.now()): QueuedDispatch[] {
  return withLock(env, () => {
    const data = readData(env);
    const hit: QueuedDispatch[] = [];
    for (const job of data.jobs) {
      if (job.state !== "waiting" || job.after !== afterId) continue;
      job.state = "blocked";
      job.reason = reason;
      hit.push({ ...job });
    }
    delete data.reruns[afterId];
    if (hit.length) writeData(env, data, now);
    return hit;
  });
}
