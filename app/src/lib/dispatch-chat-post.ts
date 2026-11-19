import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { readChatState } from "./chat-state";
import { resolveProjectCwd } from "./projects";
import { sessionLogPath } from "./session-log";
import {
  buildAppendEntry,
  findBrokenLinks,
  newlyUnpairedTools,
  type LogEntry,
} from "./session-log-edit";
import {
  withLogLock,
  isLogLive,
  snapshotLog,
  writeLogAtomic,
  LogChangedError,
} from "./session-log-lock";
import { getConfig } from "./config";

/**
 * Write a finished worker's report into the chat it belongs to, durably.
 *
 * The problem this fixes: a dispatch report reached the chat by exactly two
 * routes, and both could silently drop it.
 *
 *  1. A chat bubble injected client-side (chat-store.ts) from an EventSource on
 *     /api/dispatch/events. That bubble lives in an in-memory Map in the
 *     browser. With no tab open when the worker finished, it is never created,
 *     and nothing writes it to disk. Reopening the dashboard rehydrates from the
 *     session log, which never had it.
 *  2. vb-notifier, which pokes CVB with an [Auto-notify] message. That one IS
 *     durable, but it only initializes on the first hit of /api/dispatch/events
 *     — a route nothing touches until a browser opens a dashboard page. After a
 *     deploy or a reboot, a dispatch can finish with the notifier never booted.
 *     It also skips scopes that have no chat session yet.
 *
 * So a dispatch that completed while the owner was away could be finished, correct,
 * and invisible. That reads as "the agent never reported back", and it was
 * plumbing, not the agent.
 *
 * This appends the report to the scope's Claude Code session log as a user-role
 * entry with a marker line. Consequences, all wanted:
 *   - it rehydrates into the chat on the next load (session-log.ts renders the
 *     marker as the AGENT's bubble, not the owner's),
 *   - CVB sees it as context the next time the owner talks in that chat,
 *   - it costs nothing: no model call, unlike the vb-notifier poke.
 */

const MARKER = "[Worker report]";
/** A log written to this recently probably has a turn streaming into it. */
const BUSY_MS = 10_000;
/** Enough attempts that one lands after BUSY_MS once a turn has just ended. */
const RETRIES = 4;
const RETRY_DELAY_MS = 4000;
/** How long to wait out a registered running reply before giving up. */
const LIVE_WAIT_MS = 10 * 60_000;
const LIVE_POLL_MS = 1000;

/** Just the fields a chat post needs, so callers don't have to hold a whole ticket. */
export interface ReportPost {
  id: string;
  agent: string;
  project: string | null;
  status: string;
  summary: string | null;
  errorMessage?: string | null;
  reportPath?: string | null;
}

export type PostResult =
  | { posted: true; sessionId: string }
  | { posted: false; reason: string };

/** Where a chat scope runs. Mirrors api/chat/transcript. */
function scopeCwd(slug: string | null): string | null {
  if (!slug) return path.join(getConfig().aiteamDir, "app");
  return resolveProjectCwd(slug);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The text the owner reads in the chat. Leads with who finished and how it went,
 * then the summary, and ALWAYS ends with where the full write-up is — the whole
 * point of the exercise.
 */
export function buildReportMessage(ticket: ReportPost): string {
  const agent = ticket.agent || "worker";
  const project = ticket.project ? ` · ${ticket.project}` : "";
  const status =
    ticket.status === "done"
      ? "finished"
      : ticket.status === "failed"
      ? "failed"
      : String(ticket.status);
  const body =
    (ticket.status === "done"
      ? ticket.summary
      : ticket.errorMessage ?? ticket.summary) ?? "(no summary)";

  const where: string[] = [];
  if (ticket.reportPath) where.push(`Full write-up: ${ticket.reportPath}`);
  where.push(`Ticket ${ticket.id.slice(0, 8)} (Agents tab) has the complete report.`);

  return [`${MARKER} ${agent}${project} — ${status}`, "", body.trim(), "", ...where].join("\n");
}

async function appendOnce(
  logPath: string,
  sessionId: string,
  cwd: string,
  text: string
): Promise<PostResult> {
  // Same lock a move or a delete takes, so a report can't be renamed over an
  // edit (resurrecting deleted messages) or be lost under one.
  return withLogLock(logPath, async (): Promise<PostResult> => {
    // A registered reply is the real test; the quiet-for-10-seconds check
    // stays for anything that writes this log without registering.
    if (isLogLive(logPath)) return { posted: false, reason: "busy" };
    const snapshot = await snapshotLog(logPath);
    if (Date.now() - snapshot.mtimeMs < BUSY_MS) {
      return { posted: false, reason: "busy" };
    }

    const raw = await fs.readFile(logPath, "utf8");
    const entries: LogEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t) as LogEntry);
      } catch {
        // Not ours to repair. Appending to a log we can't fully parse risks
        // writing back something worse than we found.
        return { posted: false, reason: "unparseable log" };
      }
    }
    if (entries.length === 0) return { posted: false, reason: "empty log" };

    const lastWithUuid = [...entries].reverse().find((e) => e.uuid);
    const template = [...entries]
      .reverse()
      .find((e) => e.type === "user" && e.message?.role === "user");

    const appended = [
      ...entries,
      buildAppendEntry({
        template,
        parentUuid: lastWithUuid?.uuid ?? null,
        uuid: randomUUID(),
        sessionId,
        cwd,
        text,
        timestamp: new Date().toISOString(),
      }),
    ];

    const broken = findBrokenLinks(appended);
    if (broken.length > 0) {
      return { posted: false, reason: `would break the chain (${broken.length})` };
    }
    const orphaned = newlyUnpairedTools(entries, appended);
    if (orphaned.length > 0) {
      return { posted: false, reason: `would split tool calls (${orphaned.length})` };
    }

    // Atomic, flushed, and only if the log is still what was read: a crash
    // leaves the original intact, and a write that landed meanwhile turns into
    // a retry instead of being overwritten. Worst case is a lost append, never
    // a broken chat.
    try {
      await writeLogAtomic(
        logPath,
        appended.map((e) => JSON.stringify(e)).join("\n") + "\n",
        snapshot
      );
    } catch (err) {
      if (err instanceof LogChangedError) return { posted: false, reason: "busy" };
      throw err;
    }
    return { posted: true, sessionId };
  });
}

/**
 * Post a finished ticket's report into its chat. Never throws: this runs on the
 * dispatch completion path and must not be able to fail a dispatch.
 */
export async function postReportToChat(ticket: ReportPost): Promise<PostResult> {
  try {
    const slug = ticket.project ?? null;
    const state = await readChatState(slug);
    if (!state?.sessionId) {
      // No chat started for this scope yet. Nothing to append to, and creating a
      // session here would spawn a process nobody asked for. The ticket and the
      // task board still carry the report.
      return { posted: false, reason: "no chat session for this scope" };
    }
    const cwd = scopeCwd(slug);
    if (!cwd) return { posted: false, reason: `unknown project: ${slug}` };

    const logPath = sessionLogPath(cwd, state.sessionId);
    const text = buildReportMessage(ticket);

    // A reply running in this chat (the owner's turn, or the auto-notify that fires
    // for this very dispatch) is waited out rather than counted against the
    // retries: those can run for minutes, and giving up after a few seconds
    // would drop the report from the chat every time one overlapped.
    const liveDeadline = Date.now() + LIVE_WAIT_MS;
    for (let attempt = 0; attempt < RETRIES; ) {
      if (isLogLive(logPath)) {
        if (Date.now() > liveDeadline) return { posted: false, reason: "chat stayed busy" };
        await sleep(LIVE_POLL_MS);
        continue;
      }
      const res = await appendOnce(logPath, state.sessionId, cwd, text);
      if (res.posted) return res;
      // Anything other than "the chat is mid-turn" is not going to improve by
      // waiting, so don't sit in a retry loop over it.
      if (res.reason !== "busy") return res;
      attempt++;
      await sleep(RETRY_DELAY_MS);
    }
    return { posted: false, reason: "chat stayed busy" };
  } catch (err) {
    return { posted: false, reason: (err as Error).message };
  }
}
