import path from "node:path";
import { promises as fs } from "node:fs";
import type { ChatMessage, ContentBlock } from "./types";
import { getConfig } from "./config";

/**
 * Reads a Claude Code session log (.jsonl) from disk and reconstructs the
 * ChatMessage[] the UI would render. Used to recover transcripts when the
 * in-memory store has been cleared (HMR, tab close, etc.) — the session log
 * is the authoritative record of the conversation.
 *
 * Claude Code stores session logs at:
 *   <home>/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 * where <encoded-cwd> replaces every non-alphanumeric character in the
 * absolute cwd with `-` (one hyphen per character, not collapsed) — e.g.
 * "C:\Code\My Project" -> "C--Code-My-Project". Replacing only
 * `:`, `\`, `/` (as this used to) leaves spaces and other punctuation
 * untouched, so any project whose folder name isn't plain alphanumeric
 * silently never finds its session log.
 */

function encodeCwdForClaudeCode(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function sessionLogPath(cwd: string, sessionId: string): string {
  const encoded = encodeCwdForClaudeCode(cwd);
  return path.join(getConfig().claudeProjectsDir, encoded, `${sessionId}.jsonl`);
}

/**
 * Find a session log by session UUID alone, scanning every projects/ subdir.
 * Used as a fallback when the caller doesn't know the exact cwd (e.g. the
 * end-session route in direct mode, where the caller passes their current
 * pwd but the session was started in a different directory).
 *
 * Session UUIDs are globally unique, so the first match wins. Returns null
 * if no projects dir contains the file.
 */
export async function findSessionLogByUuid(
  sessionId: string
): Promise<string | null> {
  const projectsDir = getConfig().claudeProjectsDir;
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const target = `${sessionId}.jsonl`;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(projectsDir, e.name, target);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* not in this dir, keep looking */
    }
  }
  return null;
}

interface JsonlEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<Record<string, unknown>>;
  };
  uuid?: string;
  timestamp?: string;
}

interface ToolResult {
  content: string;
  isError: boolean;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) {
          return String((c as { text: unknown }).text);
        }
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function isToolResultOnlyMessage(
  content: string | Array<Record<string, unknown>> | undefined
): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every((c) => c?.type === "tool_result");
}

function blocksFromContent(
  content: string | Array<Record<string, unknown>> | undefined,
  toolResults: Map<string, ToolResult>
): ContentBlock[] {
  if (typeof content === "string") {
    return [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    if (item?.type === "text") {
      blocks.push({ kind: "text", text: String(item.text ?? "") });
    } else if (item?.type === "tool_use") {
      const id = String(item.id);
      const result = toolResults.get(id);
      blocks.push({
        kind: "tool_use",
        id,
        name: String(item.name ?? ""),
        input: item.input ?? {},
        ...(result
          ? { result: result.content, resultIsError: result.isError }
          : {}),
      });
    }
    // tool_result entries inside user messages are handled in the pre-pass; skip here
  }
  return blocks;
}

export async function parseSessionLog(filePath: string): Promise<ChatMessage[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseSessionLogText(raw);
}

/**
 * The same, from text already in hand. Callers that edit a log use this so the
 * messages they check a selection against come from the exact bytes they are
 * about to rewrite, not from a second read that may have seen a newer file.
 */
export function parseSessionLogText(raw: string): ChatMessage[] {
  const lines = raw.split("\n");
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as JsonlEntry);
    } catch {
      /* skip malformed line */
    }
  }

  // Pre-pass: collect every tool_result by tool_use_id
  const toolResults = new Map<string, ToolResult>();
  for (const e of entries) {
    if (e.type !== "user") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type === "tool_result") {
        const id = String(item.tool_use_id ?? "");
        if (!id) continue;
        toolResults.set(id, {
          content: stringifyToolResultContent(item.content),
          isError: Boolean(item.is_error),
        });
      }
    }
  }

  // Main pass: build ChatMessages, skipping tool-result-only user messages
  const messages: ChatMessage[] = [];
  for (const e of entries) {
    if (e.type !== "user" && e.type !== "assistant") continue;
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = e.message?.content;
    if (role === "user" && isToolResultOnlyMessage(content)) continue;
    const blocks = blocksFromContent(content, toolResults);
    if (blocks.length === 0) continue;
    // Drop the internal [Auto-notify] prompts vb-notifier injects to poke CVB. They
    // are recorded as user turns in the session log but are plumbing (meant for CVB,
    // not something the owner typed), so they must never hydrate into the visible chat.
    const first = blocks[0];
    if (role === "user" && first?.kind === "text" && first.text.startsWith("[Auto-notify]")) {
      continue;
    }
    const createdAt = e.timestamp ? new Date(e.timestamp).getTime() : Date.now();

    // A worker report written straight into the log by dispatch-chat-post.ts so
    // it survives with no browser open. It is stored as a USER entry (that is
    // the shape the conversation needs, and it puts the report in CVB's context
    // for the next turn), but it is the AGENT talking, so it renders on the
    // agent's side with the agent's name and avatar.
    const workerReport =
      role === "user" && first?.kind === "text"
        ? first.text.match(/^\[Worker report\]\s+([a-z0-9_-]+)/i)
        : null;
    if (workerReport) {
      messages.push({
        id: e.uuid ?? `${createdAt}-${messages.length}`,
        role: "assistant",
        personaName: workerReport[1].toLowerCase(),
        blocks,
        createdAt,
        pending: false,
      });
      continue;
    }

    messages.push({
      id: e.uuid ?? `${createdAt}-${messages.length}`,
      role,
      blocks,
      createdAt,
      pending: false,
    });
  }
  return messages;
}
