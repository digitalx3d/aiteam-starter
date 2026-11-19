import path from "node:path";
import { promises as fsp } from "node:fs";
import { SETTINGS_FILE } from "./config";

/**
 * Server-side state for the shared inbox, living next to the Settings file
 * (~/.aiteam/inbox-state.json) the same way hidden-projects.json does.
 *
 * Two things live here, both of which used to be missing:
 *
 *  - `read`: which entries the owner has read. This was browser localStorage, so it
 *    was per-device and per-browser -- reading on the phone left everything
 *    unread on the desktop, and clearing site data wiped it. Server-side, one
 *    read state follows him everywhere.
 *  - `seen`: when the server first observed each entry id. Entry ids are
 *    supposed to carry the posting time (`<YYYY-MM-DDTHHMM>-<from>-<slug>`) but
 *    a good number are written as `<date>T-<from>-<slug>` with the time left
 *    out. First-seen is the fallback so every entry can show a time instead of
 *    a bare date. It is recorded by the file watcher (accurate to the second)
 *    and by the inbox API as a backstop.
 *
 * Entries already sitting in the file the very first time this runs get the
 * marker `BACKFILL` instead of a timestamp. "First seen" for those means "when
 * the feature shipped", which for a two-week-old entry would render as tonight.
 * A marker means the UI shows the date alone, which is all those entries ever
 * honestly knew about themselves.
 */

export const BACKFILL = "backfill";

export interface InboxState {
  /** entry id -> ISO timestamp when it was marked read */
  read: Record<string, string>;
  /** entry id -> ISO timestamp the server first saw it */
  seen: Record<string, string>;
  /** entry id -> ISO timestamp it was first found missing from the inbox. */
  gone: Record<string, string>;
}

const EMPTY: InboxState = { read: {}, seen: {}, gone: {} };

/**
 * How long an entry must be missing before its read and first-seen marks are
 * dropped. Dropping them the moment an entry is absent wiped read state
 * whenever a parse came up short: an agent caught mid-rewrite of the file, or
 * (2026-10-16) A second instance of this app still running an older parser
 * that read 33 of 73 entries and pruned the other 40 every time it synced.
 */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function stateFile(): string {
  return path.join(path.dirname(SETTINGS_FILE), "inbox-state.json");
}

/**
 * Every mutation runs through this chain. The dashboard is a single Node
 * process, but the inbox API (recording first-seen), the read/unread route and
 * the file watcher can all land in the same tick; without serialization a
 * read-modify-write pair can drop the other's change.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  // Keep the chain alive after a rejection, but let the caller see the error.
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function sanitize(raw: unknown): InboxState {
  const out: InboxState = { read: {}, seen: {}, gone: {} };
  if (!raw || typeof raw !== "object") return out;
  for (const bucket of ["read", "seen", "gone"] as const) {
    const src = (raw as Record<string, unknown>)[bucket];
    if (!src || typeof src !== "object") continue;
    for (const [id, stamp] of Object.entries(src as Record<string, unknown>)) {
      if (typeof id === "string" && id && typeof stamp === "string" && stamp) {
        out[bucket][id] = stamp;
      }
    }
  }
  return out;
}

export async function readInboxState(): Promise<InboxState> {
  try {
    const raw = await fsp.readFile(stateFile(), "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    // Missing or malformed: start clean rather than crash the inbox.
    return { ...EMPTY, read: {}, seen: {}, gone: {} };
  }
}

/** Whether a `seen` value is a real observation or the first-run marker. */
export function isRealSighting(stamp: string | undefined): boolean {
  return Boolean(stamp) && stamp !== BACKFILL;
}

async function stateFileExists(): Promise<boolean> {
  try {
    await fsp.access(stateFile());
    return true;
  } catch {
    return false;
  }
}

/** Write via temp file + rename so an interrupted write can't truncate the state. */
async function writeInboxState(state: InboxState): Promise<void> {
  const file = stateFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, file);
}

/**
 * Record first-seen stamps for any ids we haven't met, and drop state for ids
 * that have been out of the inbox (archived) for PRUNE_AFTER_MS, so the file
 * stays small without a single short parse wiping anything.
 *
 * Pruning is skipped when `currentIds` is empty: an agent rewriting
 * inbox-shared.md can be caught mid-write, and a momentarily unparseable file
 * must not wipe read state.
 *
 * `renames` maps an id the parser used to read for an entry to the id it reads
 * now (see `legacyIdRenames`). Read and first-seen marks move across before
 * the prune, so a parser fix does not resurface old entries as unread.
 */
export async function syncInboxState(
  currentIds: string[],
  renames: Record<string, string> = {}
): Promise<InboxState> {
  return serialize(async () => {
    const firstRun = !(await stateFileExists());
    const state = await readInboxState();
    if (currentIds.length === 0) return state;

    const known = new Set(currentIds);
    let changed = false;
    for (const [oldId, newId] of Object.entries(renames)) {
      if (!known.has(newId)) continue;
      for (const bucket of ["read", "seen"] as const) {
        if (state[bucket][oldId] && !state[bucket][newId]) {
          state[bucket][newId] = state[bucket][oldId];
          changed = true;
        }
      }
    }
    // On the very first run nothing here was actually watched arriving, so the
    // whole batch is marked rather than stamped.
    const stamp = firstRun ? BACKFILL : new Date().toISOString();

    for (const id of currentIds) {
      if (!state.seen[id]) {
        state.seen[id] = stamp;
        changed = true;
      }
    }
    const now = Date.now();
    for (const id of Object.keys(state.gone)) {
      if (known.has(id)) {
        delete state.gone[id];
        changed = true;
      }
    }
    for (const id of new Set([...Object.keys(state.read), ...Object.keys(state.seen)])) {
      if (known.has(id)) continue;
      const since = Date.parse(state.gone[id] ?? "");
      if (!Number.isFinite(since)) {
        state.gone[id] = new Date(now).toISOString();
        changed = true;
      } else if (now - since > PRUNE_AFTER_MS) {
        delete state.read[id];
        delete state.seen[id];
        delete state.gone[id];
        changed = true;
      }
    }

    if (changed) await writeInboxState(state);
    return state;
  });
}

/** Mark entries read or unread. Returns the ids that are now read. */
export async function setInboxRead(
  ids: string[],
  read: boolean
): Promise<string[]> {
  return serialize(async () => {
    const state = await readInboxState();
    const now = new Date().toISOString();
    let changed = false;

    for (const id of ids) {
      if (!id) continue;
      if (read && !state.read[id]) {
        state.read[id] = now;
        changed = true;
      } else if (!read && state.read[id]) {
        delete state.read[id];
        changed = true;
      }
    }

    if (changed) await writeInboxState(state);
    return Object.keys(state.read);
  });
}
