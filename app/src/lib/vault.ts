import path from "node:path";
import { promises as fsp } from "node:fs";
import type { ChatMessage } from "./types";
import { getConfig, getOwnerName } from "./config";

export interface ArchiveResult {
  /** Absolute path to the archived transcript file. */
  filePath: string;
  /** Vault-relative path (forward slashes). */
  vaultPath: string;
  /** Number of messages archived. */
  messageCount: number;
  /** The full markdown that was written; useful for downstream distillation. */
  markdown: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDateParts(d: Date) {
  return {
    year: d.getUTCFullYear(),
    month: pad2(d.getUTCMonth() + 1),
    day: pad2(d.getUTCDate()),
    hour: pad2(d.getUTCHours()),
    minute: pad2(d.getUTCMinutes()),
  };
}

function isoStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function summarizeToolInput(input: unknown, maxLen = 120): string {
  let s: string;
  if (typeof input === "string") s = input;
  else if (input == null) s = "";
  else s = JSON.stringify(input);
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 3) + "...";
  return s;
}

function renderMessage(m: ChatMessage): string {
  const ts = new Date(m.createdAt ?? Date.now()).toISOString();
  // Single-user app: the config owner is the only human.
  const header = m.role === "user" ? `## ${getOwnerName().full}` : "## Claude Von Braun";
  // Avoid em-dashes here: vault transcripts have to survive the build pipeline's
  // encoding pass, and em-dashes have already mojibake'd once. ASCII-only.
  const lines: string[] = [`${header}  (${ts})`, ""];
  for (const block of m.blocks) {
    if (block.kind === "text") {
      lines.push(block.text);
      lines.push("");
    } else if (block.kind === "tool_use") {
      const summary = summarizeToolInput(block.input);
      lines.push(`> **[tool: \`${block.name}\`]** ${summary}`);
      if (block.result !== undefined) {
        const resultPrefix = block.resultIsError ? "error" : "result";
        const resultSummary = summarizeToolInput(block.result, 200);
        lines.push(`> *${resultPrefix}:* ${resultSummary}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

interface BuildOptions {
  messages: ChatMessage[];
  scope: string; // "default" or "project:<slug>"
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
}

function buildTranscriptMarkdown(opts: BuildOptions): string {
  const { messages, scope, sessionId, startedAt, endedAt } = opts;
  const created = isoStamp(startedAt);
  const updated = isoStamp(endedAt);
  const titleDate = isoDateParts(endedAt);
  const title = `${titleDate.year}-${titleDate.month}-${titleDate.day} ${scope} session`;

  const frontmatter = [
    "---",
    `title: ${title}`,
    "type: transcript",
    `created: ${created}`,
    `updated: ${updated}`,
    `scope: ${scope}`,
    "participants: [john, claude]",
    `session_id: ${sessionId}`,
    `message_count: ${messages.length}`,
    "filed: false",
    "---",
    "",
    `# ${title}`,
    "",
    `> Archived by the "End Session" button. Session ${sessionId}; ${messages.length} message${messages.length === 1 ? "" : "s"}.`,
    "",
  ].join("\n");

  const body = messages.map(renderMessage).join("\n");
  return `${frontmatter}\n${body}\n`;
}

/**
 * Builds the archive path: vault/transcripts/<YYYY-MM>/<YYYY-MM-DD>T<HHmm>-<safe-scope>.md
 * Safe-scope replaces ":" with "-" so "project:carpoolq" becomes "project-carpoolq".
 */
function archivePath(scope: string, endedAt: Date): { absolute: string; vaultRelative: string } {
  const p = isoDateParts(endedAt);
  const safeScope = scope.replace(/[^a-zA-Z0-9._-]/g, "-");
  const month = `${p.year}-${p.month}`;
  const file = `${p.year}-${p.month}-${p.day}T${p.hour}${p.minute}-${safeScope}.md`;
  return {
    absolute: path.join(getConfig().vaultDir, "transcripts", month, file),
    vaultRelative: `transcripts/${month}/${file}`,
  };
}

export async function archiveTranscript(opts: BuildOptions): Promise<ArchiveResult> {
  const { absolute, vaultRelative } = archivePath(opts.scope, opts.endedAt);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const md = buildTranscriptMarkdown(opts);
  await fsp.writeFile(absolute, md, "utf8");
  return {
    filePath: absolute,
    vaultPath: vaultRelative,
    messageCount: opts.messages.length,
    markdown: md,
  };
}
