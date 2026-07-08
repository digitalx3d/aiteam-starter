import { randomUUID } from "node:crypto";
import { spawnClaude } from "./claude-spawn";

/*
 * dispatch-summary.ts — turn a worker's final message into a short, plain-English
 * report for the chat bubble + task board.
 *
 * Priority:
 *   1. An explicit ===REPORT=== ... ===END=== block the agent emitted (preferred;
 *      Phase 3 personas instruct agents to end with one).
 *   2. If the raw text is already short, use it as-is.
 *   3. Otherwise compress with Haiku ("<=3 plain lines"), so a verbose agent (e.g.
 *      Ethan) can't wall-of-text the feed.
 *   4. Always fall back to truncation, so a summary is never missing.
 *
 * Part of the agent-governance-lockdown project.
 */

const REPORT_RE = /===\s*REPORT\s*===\s*([\s\S]*?)(?:===\s*END\s*===|$)/i;
const MAX_LEN = 600;

function cap(s: string): string {
  const t = s.trim();
  return t.length <= MAX_LEN ? t : t.slice(0, MAX_LEN - 3) + "...";
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Pull an explicit ===REPORT=== block, if the agent emitted one. */
export function extractReportBlock(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(REPORT_RE);
  if (!m) return null;
  const body = m[1].trim();
  return body || null;
}

/** Extract the latest assistant text from a stream-json line. */
function extractText(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (!obj || obj.type !== "assistant" || !obj.message) return null;
    const content = obj.message.content;
    if (!Array.isArray(content)) return null;
    const texts: string[] = [];
    for (const c of content) {
      if (c && c.type === "text" && typeof c.text === "string") texts.push(c.text);
    }
    const joined = texts.join("\n").trim();
    return joined || null;
  } catch {
    return null;
  }
}

/** Compress a long report to <=3 plain-English lines via a cheap Haiku pass.
 *  Returns null on any failure so the caller can fall back to truncation. */
async function compressToPlainLines(
  text: string,
  cwd: string
): Promise<string | null> {
  const prompt =
    "Rewrite the following agent status report as at most 3 short, plain-English " +
    "bullet lines for a busy non-technical reader. State what was done and any " +
    "blocker or next step. No preamble, no jargon, no markdown headers — just the " +
    "bullet lines.\n\n---\n" +
    text.slice(0, 6000);

  let child;
  let exitPromise;
  try {
    ({ child, exitPromise } = spawnClaude({
      cwd,
      sessionId: randomUUID(),
      resume: false,
      message: prompt,
      model: "haiku",
      permissionMode: "acceptEdits",
      // Pure text task — deny tools so the compressor can't wander into the repo.
      disallowedTools: ["Bash", "Edit", "Write", "Read", "Task", "WebFetch", "WebSearch"],
    }));
  } catch {
    return null;
  }

  let buffer = "";
  let last = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const t = extractText(line);
      if (t) last = t;
    }
  });

  // Don't let a hung compressor stall the completion path.
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* noop */
    }
  }, 30000);

  const { code } = await exitPromise;
  clearTimeout(timer);
  if (buffer.trim()) {
    const t = extractText(buffer.trim());
    if (t) last = t;
  }
  if (code !== 0) return null;
  const c = last.trim();
  return c ? cap(c) : null;
}

/**
 * Produce a short, plain-English summary of a worker's final message.
 * Never throws; always returns a string (or null if there was no text at all).
 */
export async function summarizeReport(
  text: string | null,
  ctx: { cwd: string }
): Promise<string | null> {
  if (!text) return null;

  const block = extractReportBlock(text);
  if (block) return cap(block);

  const collapsed = collapse(text);
  if (collapsed.length <= 400) return collapsed;

  try {
    const compressed = await compressToPlainLines(text, ctx.cwd);
    if (compressed) return compressed;
  } catch {
    /* fall through */
  }
  return cap(collapsed);
}
