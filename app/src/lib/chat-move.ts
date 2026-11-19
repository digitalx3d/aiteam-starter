import path from "node:path";
import { promises as fs, constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { readChatState } from "./chat-state";
import { resolveProjectCwd, isExactProjectSlug } from "./projects";
import { sessionLogPath, parseSessionLogText } from "./session-log";
import { getConfig, SETTINGS_FILE } from "./config";
import {
  expandRemovalSet,
  relink,
  buildAppendEntry,
  findBrokenLinks,
  newlyUnpairedTools,
  type LogEntry,
} from "./session-log-edit";
import {
  withLogLock,
  withLogLocks,
  isLogLive,
  snapshotLog,
  writeLogAtomic,
  syncFile,
  LogChangedError,
  type LogSnapshot,
} from "./session-log-lock";
import type { ChatMessage } from "./types";

/**
 * Move chat messages from one project chat to another.
 *
 * The problem this solves: replying in the wrong project chat. The message
 * lands in that project's context and stays there, while the project it was
 * meant for never gets it. Hiding the bubble in the UI would not help, because
 * the dashboard rehydrates every chat from the Claude Code session log AND
 * resumes the session from that same log on every turn. The log is the context.
 *
 * So a move is surgery on the log:
 *
 *  - Source: the selected entries are deleted and the conversation is re-linked
 *    around the hole (each entry carries a `parentUuid` pointing at the one
 *    before it, so the chain has to be repaired or the resume breaks). This is
 *    a real purge: the next turn in that chat cannot see the moved text.
 *  - Target: the moved text is appended as one quoted user entry, marked with
 *    where it came from. Appended, not sent: re-sending would make the agent
 *    act on it, and a stray "deploy to prod" landing in the right project is
 *    still not an instruction to deploy right now.
 *
 * Every log touched is copied to ~/.aiteam/chat-move-backups/ before anything
 * is written, because this edits a file format that belongs to Claude Code.
 * Every rewrite goes through session-log-lock.ts, which is what keeps a move,
 * a delete, a worker report and a running reply from overwriting each other.
 *
 * Deleting lives here too, on purpose. Not every stray message belongs in
 * another chat; most belong nowhere (a typo, a half thought, a duplicate). A
 * delete is the source half of a move and nothing else, so both run through
 * prepareSourceRemoval() below rather than through two copies of the same
 * surgery that can drift apart.
 */

/** Backups kept per chat, newest first, once they are past the age floor. */
const BACKUPS_PER_CHAT = 20;
/** A backup younger than this is never pruned, however many there are. */
const BACKUP_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface MoveRequest {
  /** Project slug the messages are leaving. null = the default Dashboard chat. */
  fromSlug: string | null;
  /** Project slug the messages are going to. null = the default Dashboard chat. */
  toSlug: string | null;
  /** Session-log entry uuids, which are the ids the chat UI already uses. */
  uuids: string[];
  /** Who asked (remote address), for the audit line. */
  actor?: string;
}

export interface MoveResult {
  /** Entries removed from the source log, including tool results and attachments. */
  removed: number;
  /** Chat messages whose text was carried across. */
  moved: number;
  backupPath: string;
  /** Pre-append copy of the target log. null when the text was parked instead. */
  targetBackupPath: string | null;
  /** True when the target had no session yet and the text was parked for it. */
  parked: boolean;
}

export interface DeleteRequest {
  /** Project slug the messages are being removed from. null = Dashboard chat. */
  slug: string | null;
  /** Session-log entry uuids, which are the ids the chat UI already uses. */
  uuids: string[];
  /** Who asked (remote address), for the audit line. */
  actor?: string;
}

export interface DeleteResult {
  /** Entries removed from the log, including tool results and attachments. */
  removed: number;
  /** Chat messages the user actually picked. */
  deleted: number;
  /** Absolute path of the pre-edit copy of the log. */
  backupPath: string;
  /** Absolute path of the session log that was edited. */
  logPath: string;
  /** One line of PowerShell that puts the backup back. */
  restoreCommand: string;
}

export class ChatEditError extends Error {}

/** Kept so existing callers that catch MoveError keep working; same class. */
export { ChatEditError as MoveError };

/** Where pre-edit copies of session logs go. Absolute, shown to the user. */
export function chatBackupsDir(): string {
  return path.join(path.dirname(SETTINGS_FILE), "chat-move-backups");
}

/** One JSON line per edit, so there is a record even after a backup is pruned. */
export function chatEditsLogPath(): string {
  return path.join(path.dirname(SETTINGS_FILE), "chat-edits.log");
}

/**
 * A chat name safe to put in a filename. A raw slug with `:` in it would write
 * into an NTFS alternate stream instead of a file (Ethan's L1).
 */
function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * The command that undoes an edit: copy the backup back over the log. Single
 * quotes so PowerShell expands nothing inside the paths.
 */
export function restoreCommandFor(backupPath: string, logPath: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `Copy-Item -LiteralPath ${q(backupPath)} -Destination ${q(logPath)} -Force`;
}

/**
 * A chat slug from a request body. Absent or null means the Dashboard chat;
 * anything else has to be a string naming a project folder exactly. Refusing
 * here keeps a non-string from surfacing as a raw 500 and keeps odd spellings
 * away from the filenames built from the slug (Ethan's L1).
 */
export async function parseChatSlug(
  value: unknown
): Promise<{ ok: true; slug: string | null } | { ok: false; error: string }> {
  if (value === undefined || value === null) return { ok: true, slug: null };
  if (typeof value !== "string") return { ok: false, error: "slug must be a string or null" };
  if (!(await isExactProjectSlug(value))) return { ok: false, error: `Unknown project: ${value}` };
  return { ok: true, slug: value };
}

/** Who sent a request, as well as the server can tell, for the audit line. */
export function requestActor(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

/** Where a scope's chat runs. Mirrors the transcript route. */
function scopeCwd(slug: string | null): string {
  if (!slug) return path.join(getConfig().aiteamDir, "app");
  const resolved = resolveProjectCwd(slug);
  if (!resolved) throw new ChatEditError(`Unknown project: ${slug}`);
  return resolved;
}

function scopeLabel(slug: string | null): string {
  return slug ?? "Dashboard";
}

interface LogLocation {
  slug: string | null;
  sessionId: string;
  cwd: string;
  logPath: string;
}

async function locateLog(slug: string | null): Promise<LogLocation | null> {
  const state = await readChatState(slug);
  if (!state?.sessionId) return null;
  const cwd = scopeCwd(slug);
  return { slug, sessionId: state.sessionId, cwd, logPath: sessionLogPath(cwd, state.sessionId) };
}

function parseEntries(raw: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // A malformed line is not ours to fix, but dropping it would lose
      // conversation. Refuse the whole edit instead.
      throw new ChatEditError(
        "The session log has a line this build can't parse; not editing it."
      );
    }
  }
  return out;
}

function serialize(entries: LogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** The log's bytes plus the size and age they had, taken before the read. */
async function readForEdit(file: string): Promise<{ raw: string; snapshot: LogSnapshot }> {
  // Snapshot first: a write landing between the two makes the later re-check
  // fail (a safe refusal) rather than letting a stale read through.
  const snapshot = await snapshotLog(file);
  const raw = await fs.readFile(file, "utf8");
  return { raw, snapshot };
}

/** Rename into place only if nobody wrote since readForEdit(). */
async function commit(file: string, entries: LogEntry[], snapshot: LogSnapshot): Promise<void> {
  try {
    await writeLogAtomic(file, serialize(entries), snapshot);
  } catch (err) {
    if (err instanceof LogChangedError) throw new ChatEditError(err.message);
    throw err;
  }
}

/**
 * Never write a log that cannot be resumed. The parent chain has to close,
 * and no tool call or tool result may lose its other half because of this
 * edit. Cheap insurance against a bug here (or a hand-made request) leaving a
 * chat the API rejects.
 */
function assertWritable(before: LogEntry[], after: LogEntry[], label: string): void {
  const broken = findBrokenLinks(after);
  if (broken.length > 0) {
    throw new ChatEditError(
      `Refusing to write the ${label} chat: ${broken.length} broken link(s), e.g. ${broken[0]}`
    );
  }
  const orphaned = newlyUnpairedTools(before, after);
  if (orphaned.length > 0) {
    throw new ChatEditError(
      `Refusing to write the ${label} chat: it would split ${orphaned.length} tool call(s) from their results.`
    );
  }
}

/**
 * Refuse to edit a log a reply is running against. The registry is the real
 * test: the chat route and vb-notifier register every turn they start. The
 * written-to-seconds-ago test stays underneath it for anything that did not
 * register (a terminal Claude resuming the same session).
 */
async function assertEditable(file: string, label: string): Promise<void> {
  const busy = `The ${label} chat is mid-reply. Wait for it to finish, then try again.`;
  if (isLogLive(file)) throw new ChatEditError(busy);
  const stat = await fs.stat(file);
  if (Date.now() - stat.mtimeMs < 5000) throw new ChatEditError(busy);
}

/** The visible text of a message, tool calls summarized rather than replayed. */
function messageText(m: ChatMessage): string {
  const parts: string[] = [];
  for (const b of m.blocks) {
    if (b.kind === "text" && b.text.trim()) parts.push(b.text.trim());
    else if (b.kind === "tool_use") parts.push(`(used ${b.name})`);
  }
  return parts.join("\n\n");
}

function buildMovedBlock(
  messages: ChatMessage[],
  fromSlug: string | null,
  ownerLabel: string,
  agentLabel: string
): string {
  const lines = messages.map((m) => {
    const who = m.role === "user" ? ownerLabel : agentLabel;
    return `${who}: ${messageText(m)}`;
  });
  return [
    `[Moved here from the ${scopeLabel(fromSlug)} chat, where it was posted by mistake.`,
    `It has been removed from that chat. Context only, not a new instruction.]`,
    "",
    ...lines,
  ].join("\n");
}

/** `<chat>-<sessionId>-<stamp>.jsonl`, or the older `<chat>-<stamp>.jsonl`. */
const BACKUP_NAME =
  /^(.+?)-(?:[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}-)?(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.jsonl$/;

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** "2026-09-28T12-34-56-789Z" back to a time. */
function stampToMs(stamp: string): number {
  const iso = stamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z"
  );
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/**
 * Copy a log aside before editing it. Returns the absolute path of the copy.
 *
 * Pruning goes by the time in the FILENAME, per chat, and never touches the
 * copy just made. It used to go by the file's modified time across one shared
 * pool, and a Windows copy keeps the SOURCE's modified time, so a backup of a
 * chat that had been quiet for a week sorted as the oldest file and was
 * deleted in the same call that made it (Ethan's H1). The copy is also
 * re-stamped to now so anything else sorting by date sees it correctly.
 */
async function saveBackup(file: string, slug: string | null, sessionId: string): Promise<string> {
  const dir = chatBackupsDir();
  await fs.mkdir(dir, { recursive: true });
  const chat = safeName(slug ?? "dashboard");

  let dest = "";
  for (let attempt = 0; ; attempt++) {
    dest = path.join(dir, `${chat}-${safeName(sessionId)}-${stampNow()}.jsonl`);
    try {
      await fs.copyFile(file, dest, fsConstants.COPYFILE_EXCL);
      break;
    } catch (err) {
      // Same chat, same millisecond: wait one tick and take a new stamp.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 2));
    }
  }
  const now = new Date();
  await fs.utimes(dest, now, now);
  // The backup is the undo for a power cut mid-edit too, so it has to be on
  // the disk before the log is touched.
  await syncFile(dest);

  await pruneBackups(dir, chat, path.basename(dest));
  return dest;
}

async function pruneBackups(dir: string, chat: string, justWritten: string): Promise<void> {
  try {
    const mine = (await fs.readdir(dir))
      .map((name) => ({ name, m: BACKUP_NAME.exec(name) }))
      .filter((f) => f.m && f.m[1] === chat)
      .map((f) => ({ name: f.name, stamp: f.m![2] }))
      .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
    const cutoff = Date.now() - BACKUP_MIN_AGE_MS;
    for (const old of mine.slice(BACKUPS_PER_CHAT)) {
      if (old.name === justWritten) continue;
      if (stampToMs(old.stamp) > cutoff) continue;
      await fs.unlink(path.join(dir, old.name)).catch(() => {});
    }
  } catch {
    /* pruning is best-effort */
  }
}

/**
 * One line per successful edit. Best-effort: a full disk here must not turn a
 * finished edit into a reported failure.
 */
async function audit(line: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(chatEditsLogPath()), { recursive: true });
    await fs.appendFile(
      chatEditsLogPath(),
      JSON.stringify({ time: new Date().toISOString(), ...line }) + "\n",
      "utf8"
    );
  } catch (err) {
    console.error("[chat-move] audit line not written:", (err as Error).message);
  }
}

/** Text parked for a chat that has no session yet, injected on its next turn. */
export function parkedMovePath(slug: string | null): string {
  return path.join(
    path.dirname(SETTINGS_FILE),
    "chat-parked-moves",
    `${safeName(slug ?? "_default")}.md`
  );
}

export async function readParkedMove(slug: string | null): Promise<string | null> {
  try {
    const text = await fs.readFile(parkedMovePath(slug), "utf8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

export async function clearParkedMove(slug: string | null): Promise<void> {
  await fs.unlink(parkedMovePath(slug)).catch(() => {});
}

/** Park text for a chat. Returns a function that puts the file back as it was. */
async function parkMove(slug: string | null, text: string): Promise<() => Promise<void>> {
  const file = parkedMovePath(slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    /* first park for this chat */
  }
  await fs.writeFile(file, existing ? `${existing.trim()}\n\n${text}\n` : `${text}\n`, "utf8");
  return async () => {
    if (existing === null) await fs.unlink(file).catch(() => {});
    else await fs.writeFile(file, existing, "utf8");
  };
}

/**
 * Everything a move and a delete do to the chat the messages are LEAVING, up to
 * but not including the write. Must run inside that log's lock.
 *
 * Only messages the chat actually renders can be removed. The removal set is
 * grown from those alone (plus what hangs off them), and a request naming
 * anything else is refused whole: a stale tab, a UI bug or a hand-made request
 * must not be able to take out a tool result or a hidden row nobody could see
 * or pick (Ethan's M1).
 *
 * Nothing on disk is modified except the backup copy, so a caller that throws
 * after this returns has still changed no conversation.
 */
async function prepareSourceRemoval(
  loc: LogLocation,
  uuids: string[]
): Promise<{
  /** The rendered messages the user picked, text intact. */
  picked: ChatMessage[];
  /** The log as it should be written: picked entries gone, chain repaired. */
  kept: LogEntry[];
  /** Log rows dropped, which exceeds picked.length by tool results/attachments. */
  removedCount: number;
  snapshot: LogSnapshot;
  backupPath: string;
}> {
  const label = scopeLabel(loc.slug);
  await assertEditable(loc.logPath, label);

  const { raw, snapshot } = await readForEdit(loc.logPath);
  const entries = parseEntries(raw);
  const rowIds = new Set(entries.map((e) => e.uuid).filter(Boolean) as string[]);
  // Rendered messages from the same bytes: the text has to be captured before
  // the entries go, and the selection is checked against what the UI can show.
  const selectable = parseSessionLogText(raw).filter((m) => rowIds.has(m.id));
  const selectableIds = new Set(selectable.map((m) => m.id));

  const unknown = uuids.filter((u) => !selectableIds.has(u));
  if (unknown.length > 0) {
    throw new ChatEditError(
      `Your selection is out of date: ${unknown.length} of the picked message(s) ` +
        `are not in this chat as it stands. Reload the chat and pick again.`
    );
  }
  const wanted = new Set(uuids);
  const picked = selectable.filter((m) => wanted.has(m.id));

  const removed = expandRemovalSet(entries, picked.map((m) => m.id));
  const kept = relink(entries, removed);
  assertWritable(entries, kept, label);

  const backupPath = await saveBackup(loc.logPath, loc.slug, loc.sessionId);
  return { picked, kept, removedCount: entries.length - kept.length, snapshot, backupPath };
}

/**
 * Delete chat messages outright. A move without a destination: the entries come
 * out of the log, the chain is repaired around the hole, and the text is gone
 * from the conversation the next turn resumes from. Not undoable from the UI;
 * the pre-edit copy under chatBackupsDir() is the way back, and the result
 * carries the one command that restores it.
 */
export async function deleteChatMessages(req: DeleteRequest): Promise<DeleteResult> {
  if (req.uuids.length === 0) throw new ChatEditError("No messages selected.");
  const loc = await locateLog(req.slug);
  if (!loc) throw new ChatEditError(`The ${scopeLabel(req.slug)} chat has no session to edit.`);

  return withLogLock(loc.logPath, async () => {
    const { picked, kept, removedCount, snapshot, backupPath } = await prepareSourceRemoval(
      loc,
      req.uuids
    );
    await commit(loc.logPath, kept, snapshot);

    await audit({
      action: "delete",
      remote: req.actor ?? "unknown",
      slug: loc.slug,
      sessionId: loc.sessionId,
      messages: picked.length,
      rows: removedCount,
      backupPath,
      logPath: loc.logPath,
    });
    return {
      removed: removedCount,
      deleted: picked.length,
      backupPath,
      logPath: loc.logPath,
      restoreCommand: restoreCommandFor(backupPath, loc.logPath),
    };
  });
}

export async function moveChatMessages(
  req: MoveRequest,
  labels: { owner: string; agent: string }
): Promise<MoveResult> {
  const { fromSlug, toSlug, uuids } = req;
  if (fromSlug === toSlug) throw new ChatEditError("Source and target are the same chat.");
  if (uuids.length === 0) throw new ChatEditError("No messages selected.");

  const from = await locateLog(fromSlug);
  if (!from) throw new ChatEditError(`The ${scopeLabel(fromSlug)} chat has no session to edit.`);
  const to = await locateLog(toSlug);

  // Both logs under lock for the whole move, in a fixed order (withLogLocks).
  return withLogLocks(to ? [from.logPath, to.logPath] : [from.logPath], async () => {
    const {
      picked: moving,
      kept,
      removedCount,
      snapshot,
      backupPath,
    } = await prepareSourceRemoval(from, uuids);

    // Target first: if appending fails, the source is still intact and the move
    // simply did not happen, which is the safe direction to fail in.
    const movedText = buildMovedBlock(moving, fromSlug, labels.owner, labels.agent);
    let parked = false;
    let targetBackupPath: string | null = null;
    let undoTarget: () => Promise<void>;

    const targetExists = to
      ? await fs.stat(to.logPath).then(
          () => true,
          (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") return false;
            throw err;
          }
        )
      : false;

    if (to && targetExists) {
      const label = scopeLabel(toSlug);
      await assertEditable(to.logPath, label);
      const { raw: toRaw, snapshot: toSnapshot } = await readForEdit(to.logPath);
      const toEntries = parseEntries(toRaw);
      const lastWithUuid = [...toEntries].reverse().find((e) => e.uuid);
      const template = [...toEntries]
        .reverse()
        .find((e) => e.type === "user" && e.message?.role === "user");
      const appended = [
        ...toEntries,
        buildAppendEntry({
          template,
          parentUuid: lastWithUuid?.uuid ?? null,
          uuid: randomUUID(),
          sessionId: to.sessionId,
          cwd: to.cwd,
          text: movedText,
          timestamp: new Date().toISOString(),
        }),
      ];
      assertWritable(toEntries, appended, label);
      // The target is rewritten too, so it gets the same backup (Ethan's I3).
      targetBackupPath = await saveBackup(to.logPath, toSlug, to.sessionId);
      await commit(to.logPath, appended, toSnapshot);
      const afterAppend = await snapshotLog(to.logPath);
      undoTarget = () => writeLogAtomic(to.logPath, toRaw, afterAppend);
    } else {
      // No session, or a session created but never spoken to (no log yet).
      undoTarget = await parkMove(toSlug, movedText);
      parked = true;
    }

    try {
      await commit(from.logPath, kept, snapshot);
    } catch (err) {
      // The text reached the target but the source could not be edited. Take
      // it back out of the target, or the move leaves it in both chats.
      try {
        await undoTarget();
      } catch {
        throw new ChatEditError(
          `The messages were copied to ${scopeLabel(toSlug)} but could not be removed ` +
            `from ${scopeLabel(fromSlug)}, and the copy could not be taken back. ` +
            `Backups: ${backupPath}${targetBackupPath ? ` and ${targetBackupPath}` : ""}`
        );
      }
      throw err;
    }

    await audit({
      action: "move",
      remote: req.actor ?? "unknown",
      slug: fromSlug,
      sessionId: from.sessionId,
      toSlug,
      toSessionId: to?.sessionId ?? null,
      parked,
      messages: moving.length,
      rows: removedCount,
      backupPath,
      logPath: from.logPath,
      targetBackupPath,
      targetLogPath: parked ? null : to?.logPath ?? null,
    });
    return { removed: removedCount, moved: moving.length, backupPath, targetBackupPath, parked };
  });
}
