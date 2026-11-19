import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Coordination for everything in this server that rewrites a chat's Claude
 * Code session log: moving and deleting messages (chat-move.ts) and posting a
 * worker report (dispatch-chat-post.ts). Each of those reads the whole log,
 * rebuilds it, and renames the result over the original. Two of them doing
 * that at once, or one doing it while a Claude turn is appending to the same
 * file, loses rows silently: whichever rename lands last wins and the other
 * writer's change is gone (Ethan's H2, 2026-09-28).
 *
 * Three layers, all keyed by the log's absolute path:
 *
 *  1. withLogLock(): one writer at a time inside this process.
 *  2. Live turns: the chat route and vb-notifier register a spawn that is
 *     resuming a log for as long as it runs, and a rewrite refuses while one
 *     is registered. The old "written to in the last few seconds" test stays as
 *     a second layer, but it cannot see a turn sitting inside a long tool call.
 *  3. writeLogAtomic(): the rewrite is only renamed into place if the file is
 *     still the size and age it was when it was read. Anything outside this
 *     process that wrote meanwhile (a terminal Claude on the same session)
 *     turns into a refusal instead of a lost write.
 *
 * State lives on globalThis, not in module scope: Next can load a server
 * module more than once across route bundles, and a lock that exists twice is
 * no lock.
 */

interface Registry {
  /** Tail of the promise chain per log: the next writer waits on it. */
  locks: Map<string, Promise<void>>;
  /** Running Claude turns per log. A count, since two can overlap briefly. */
  live: Map<string, number>;
}

const REGISTRY_KEY = Symbol.for("aiteam.session-log-lock");

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let reg = g[REGISTRY_KEY];
  if (!reg) {
    reg = { locks: new Map(), live: new Map() };
    g[REGISTRY_KEY] = reg;
  }
  return reg;
}

/** One key per file, however the path was spelled. Windows paths ignore case. */
function keyFor(logPath: string): string {
  const resolved = path.resolve(logPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Run fn with exclusive write access to one session log (in this process). */
export async function withLogLock<T>(logPath: string, fn: () => Promise<T>): Promise<T> {
  const { locks } = registry();
  const key = keyFor(logPath);
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Only clear the entry if nobody queued behind us; otherwise it is theirs.
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/**
 * Lock several logs at once (a move touches two). Always taken in the same
 * order, so a move A to B and a move B to A can't each hold one and wait
 * forever on the other.
 */
export async function withLogLocks<T>(logPaths: string[], fn: () => Promise<T>): Promise<T> {
  const unique = [...new Map(logPaths.map((p) => [keyFor(p), p])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, p]) => p);
  const run = (i: number): Promise<T> =>
    i >= unique.length ? fn() : withLogLock(unique[i], () => run(i + 1));
  return run(0);
}

/**
 * Register a Claude process resuming this log. Returns the release function;
 * call it exactly once when the process exits.
 *
 * Registration waits for the log's lock, so a turn can never start between a
 * rewrite's read and its rename: either the turn registered first and the
 * rewrite refuses, or the rewrite finishes and the turn resumes from the
 * edited file.
 */
export async function markLogLive(logPath: string): Promise<() => void> {
  const { live } = registry();
  const key = keyFor(logPath);
  await withLogLock(logPath, async () => {
    live.set(key, (live.get(key) ?? 0) + 1);
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (live.get(key) ?? 1) - 1;
    if (n <= 0) live.delete(key);
    else live.set(key, n);
  };
}

/** True while a registered Claude turn is running against this log. */
export function isLogLive(logPath: string): boolean {
  return (registry().live.get(keyFor(logPath)) ?? 0) > 0;
}

/** Size and modified time at the moment a log was read: the write precondition. */
export interface LogSnapshot {
  size: number;
  mtimeMs: number;
}

export async function snapshotLog(logPath: string): Promise<LogSnapshot> {
  const st = await fs.stat(logPath);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

/** The log changed between our read and our write; nothing was written. */
export class LogChangedError extends Error {
  constructor() {
    super("The chat changed while this edit was being prepared. Nothing was changed; try again.");
  }
}

/** Write a file and flush it to the disk before returning. */
export async function writeFileDurable(file: string, body: string): Promise<void> {
  const handle = await fs.open(file, "w");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flush an already-written file (a copyFile result) to the disk. */
export async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replace a log with new contents, atomically and durably, but only if it is
 * still exactly what was read.
 *
 * The temp name is unique per write so two writers can never share one file.
 * The data is flushed before the rename: on a power cut NTFS can commit the
 * rename ahead of the data, which would leave an empty chat log. The re-check
 * sits right before the rename, as late as it can go.
 */
export async function writeLogAtomic(
  logPath: string,
  body: string,
  expected: LogSnapshot
): Promise<void> {
  const tmp = `${logPath}.${randomUUID()}.tmp`;
  try {
    await writeFileDurable(tmp, body);
    const now = await snapshotLog(logPath);
    if (now.size !== expected.size || now.mtimeMs !== expected.mtimeMs) {
      throw new LogChangedError();
    }
    await fs.rename(tmp, logPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
