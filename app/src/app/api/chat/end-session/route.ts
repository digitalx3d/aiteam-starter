import path from "node:path";
import { promises as fsp } from "node:fs";
import { deleteChatState, readChatState } from "@/lib/chat-state";
import { resolveProjectCwd } from "@/lib/projects";
import {
  findSessionLogByUuid,
  parseSessionLog,
  sessionLogPath,
} from "@/lib/session-log";
import { archiveTranscript } from "@/lib/vault";
import { distillSessionAsync } from "@/lib/claude-distill";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EndSessionResponse {
  ok: boolean;
  archived: boolean;
  vaultPath?: string;
  messageCount?: number;
  sessionId?: string;
  reason?: string;
  error?: string;
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("project") || null;

  // Direct mode: caller provides sessionId + cwd + scope explicitly. This bypasses
  // the chat-states lookup so external callers (CLI sessions, scripts, ad-hoc tools)
  // can end-session a Claude Code session that doesn't live inside the app's
  // chat lifecycle. In direct mode we do NOT delete any chat-state file.
  const sessionIdParam = url.searchParams.get("sessionId");
  const directMode = Boolean(sessionIdParam);

  let sessionId: string;
  let cwd: string;
  let scope: string;

  if (directMode) {
    sessionId = sessionIdParam!;
    const cwdParam = url.searchParams.get("cwd");
    cwd = cwdParam ? path.resolve(cwdParam) : path.join(getConfig().aiteamDir, "app");
    scope = url.searchParams.get("scope") || "external";
  } else {
    scope = slug ? `project:${slug}` : "default";

    const state = await readChatState(slug);
    if (!state?.sessionId) {
      const payload: EndSessionResponse = {
        ok: true,
        archived: false,
        reason: "no-active-session",
      };
      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      });
    }
    sessionId = state.sessionId;

    if (slug) {
      const resolved = resolveProjectCwd(slug);
      if (!resolved) {
        const payload: EndSessionResponse = {
          ok: false,
          archived: false,
          error: `Unknown project: ${slug}`,
        };
        return new Response(JSON.stringify(payload), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      cwd = resolved;
    } else {
      // Match the chat route: CVB's default chat lives in app/.
      cwd = path.join(getConfig().aiteamDir, "app");
    }
  }

  let logPath = sessionLogPath(cwd, sessionId);
  let messages = await parseSessionLog(logPath);

  // Direct-mode fallback: the caller's cwd may not match the cwd Claude Code
  // used when the session started (e.g. they `cd`d into a subdirectory).
  // Session UUIDs are globally unique, so scan all projects/ subdirs.
  if (directMode && messages.length === 0) {
    const found = await findSessionLogByUuid(sessionId);
    if (found) {
      logPath = found;
      messages = await parseSessionLog(logPath);
    }
  }

  if (messages.length === 0) {
    // Nothing to archive — likely a session-id was created but the chat was never
    // actually used. Still clear state so next message gets a fresh ID.
    if (!directMode) await deleteChatState(slug);
    const payload: EndSessionResponse = {
      ok: true,
      archived: false,
      reason: "empty-transcript",
      sessionId,
    };
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Use the log file's mtime as the "ended at" stamp and the first message's
  // createdAt as "started at." Falls back to now() if either is missing.
  const startedAt = new Date(messages[0]?.createdAt ?? Date.now());
  let endedAt = new Date();
  try {
    const stat = await fsp.stat(logPath);
    endedAt = stat.mtime;
  } catch {
    /* keep now() */
  }

  let archived;
  try {
    archived = await archiveTranscript({
      messages,
      scope,
      sessionId,
      startedAt,
      endedAt,
    });
  } catch (err) {
    const payload: EndSessionResponse = {
      ok: false,
      archived: false,
      error: `Failed to write transcript: ${(err as Error).message}`,
    };
    return new Response(JSON.stringify(payload), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Only reset chat state after the archive write has succeeded.
  // In direct mode the session doesn't live in chat-states; nothing to delete.
  if (!directMode) await deleteChatState(slug);

  // Fire-and-forget: distill this session into a rolling primer for the next
  // session in the same scope. The route returns immediately; the distillation
  // runs in the background. Errors are logged inside, not surfaced.
  distillSessionAsync({
    transcriptMd: archived.markdown,
    scope,
    cwd,
    transcriptPath: archived.vaultPath,
  });

  const payload: EndSessionResponse = {
    ok: true,
    archived: true,
    vaultPath: archived.vaultPath,
    messageCount: archived.messageCount,
    sessionId,
  };
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}
