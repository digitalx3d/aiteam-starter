import { EventEmitter } from "node:events";
import path from "node:path";
import { getConfig, getOwnerName } from "./config";
import { spawnClaude } from "./claude-spawn";
import { buildCvbHookSettings } from "./cvb-hooks";
import { readChatState } from "./chat-state";
import { resolveProjectCwd } from "./projects";
import { sessionLogPath } from "./session-log";
import { markLogLive } from "./session-log-lock";
import { subscribe as subscribeDispatch, type DispatchTicket } from "./dispatch-store";

// VB Notifier — server-side subscriber to dispatch completions that auto-pokes
// Von Braun's dashboard session with an [Auto-notify] message so VB stays
// aware between the owner's manual turns. Uses Haiku for the auto-ack to keep
// running cost low; VB's persona limits him to a one-line acknowledgment
// unless action is genuinely needed.

const NOTIFY_MODEL = "haiku";

export interface VbReplyEvent {
  scope: string;
  ticketId: string;
  text: string;
  /** epoch ms when VB finished replying. */
  ts: number;
}

const replyEmitter = new EventEmitter();

/** Subscribe to VB auto-reply events. Returns an unsubscribe function. */
export function subscribeVbReply(
  handler: (evt: VbReplyEvent) => void
): () => void {
  replyEmitter.on("reply", handler);
  return () => replyEmitter.off("reply", handler);
}

// Serialize auto-notifies per scope so two concurrent dispatches don't try to
// resume the same VB session at the same time (which would race on the .jsonl).
const queueByScope = new Map<string, Promise<void>>();

let initialized = false;

/** Idempotent. Subscribes the notifier to the dispatch store on first call. */
export function ensureVbNotifier(): void {
  if (initialized) return;
  initialized = true;
  subscribeDispatch(handleDispatchEvent);
}

function handleDispatchEvent(ticket: DispatchTicket): void {
  if (
    ticket.status !== "done" &&
    ticket.status !== "failed" &&
    ticket.status !== "cancelled"
  ) {
    return;
  }
  const scope = ticket.project ? `project:${ticket.project}` : "default";
  const prev = queueByScope.get(scope) ?? Promise.resolve();
  const next = prev
    .then(() => sendAutoNotify(ticket, scope))
    .catch((err) => {
      console.error("[vb-notifier] sendAutoNotify failed:", err);
    });
  queueByScope.set(scope, next);
}

async function sendAutoNotify(
  ticket: DispatchTicket,
  scope: string
): Promise<void> {
  // Only auto-poke a session that the owner has already started. If there's no
  // active VB session for this scope yet, skip — there's nothing to inject
  // into and we shouldn't auto-create a session.
  const slug = ticket.project ?? null;
  const state = await readChatState(slug);
  if (!state || !state.started) return;

  // Default scope's cwd must match the chat route's default — app/, not the
  // project root — so the auto-notify resumes the same .jsonl that CVB writes
  // to via /api/chat.
  const aiteamDir = getConfig().aiteamDir;
  const cwd = slug
    ? resolveProjectCwd(slug) ?? aiteamDir
    : path.join(aiteamDir, "app");

  const message = buildAutoNotifyMessage(ticket);

  // Resume VB's session on Haiku. No append-system-prompt — resume inherits.
  // Still carries the guard + clock hooks: this is CVB acting, so the same
  // deliverable/governance write-block applies during an auto-notify.
  // Registered as a live turn so a move, delete or report post to this chat
  // is refused while it runs instead of rewriting the log underneath it.
  const releaseLive = await markLogLive(sessionLogPath(cwd, state.sessionId));
  let spawned: ReturnType<typeof spawnClaude>;
  try {
    spawned = spawnClaude({
      cwd,
      sessionId: state.sessionId,
      resume: true,
      message,
      model: NOTIFY_MODEL,
      permissionMode: "acceptEdits",
      settings: buildCvbHookSettings(),
    });
  } catch (err) {
    releaseLive();
    throw err;
  }
  const { child, exitPromise } = spawned;

  let buffer = "";
  let lastAssistantText: string | null = null;
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const text = extractAssistantText(line);
      if (text) lastAssistantText = text;
    }
  });

  const { code } = await exitPromise.finally(releaseLive);
  if (buffer.trim()) {
    const text = extractAssistantText(buffer.trim());
    if (text) lastAssistantText = text;
  }

  if (code !== 0 || !lastAssistantText) return;

  replyEmitter.emit("reply", {
    scope,
    ticketId: ticket.id,
    text: lastAssistantText,
    ts: Date.now(),
  } as VbReplyEvent);
}

/** Ceiling on the report text inlined into CVB's notify. Generous on purpose:
 *  this runs on Haiku, so a few extra KB is negligible next to CVB acting on a
 *  half-read report. Anything longer is pointed at rather than pasted. */
const INLINE_REPORT_MAX = 4000;

function buildAutoNotifyMessage(ticket: DispatchTicket): string {
  const agent = capitalize(ticket.agent);
  const projectTag = ticket.project ? ` (${ticket.project})` : "";
  const statusLine =
    ticket.status === "done"
      ? `finished and reported:`
      : ticket.status === "failed"
      ? `failed:`
      : `was cancelled:`;

  // Prefer the unabridged report. `summary` is capped at 600 chars for the Live
  // Feed and the chat bubble; handing CVB that version meant he routinely acted
  // on a report cut off mid-sentence, with no ticket id and no path, so he could
  // not go and read the rest even when he noticed it was clipped.
  let body: string;
  if (ticket.status === "done") {
    const full = ticket.report?.trim() || "";
    if (full.length > INLINE_REPORT_MAX) {
      body = `${full.slice(0, INLINE_REPORT_MAX)}\n\n[Report continues. Full text: .dispatches/${ticket.id}.json -> "report"]`;
    } else {
      body = full || ticket.summary?.trim() || "(no summary)";
    }
  } else if (ticket.status === "failed") {
    body = ticket.errorMessage ?? "unknown error";
  } else {
    body = "cancelled.";
  }

  return [
    `[Auto-notify] ${agent}${projectTag} ${statusLine}`,
    "",
    body,
    "",
    `(ticket ${ticket.id} — full report at .dispatches/${ticket.id}.json)`,
    "",
    `Acknowledge tersely (one line). If this update suggests follow-on work, name it plainly but do NOT dispatch — wait for ${getOwnerName().first}'s next manual turn.`,
  ].join("\n");
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Pull the latest assistant-message text out of a stream-json line, if any. */
function extractAssistantText(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== "object") return null;
    if (obj.type !== "assistant" || !obj.message) return null;
    const content = obj.message.content;
    if (!Array.isArray(content)) return null;
    const texts: string[] = [];
    for (const c of content) {
      if (c && c.type === "text" && typeof c.text === "string") {
        texts.push(c.text);
      }
    }
    const joined = texts.join("\n").trim();
    return joined || null;
  } catch {
    return null;
  }
}
