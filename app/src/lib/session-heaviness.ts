import { promises as fsp } from "node:fs";

// Same thresholds the vault-indexer's autocommit sweep uses (scripts/vault-index/autocommit.mjs)
// — kept in sync via identical env var names so one config change covers both.
// This module only decides whether to show John a live warning; the sweep is
// what actually archives the chat.
export const HEAVY_TOKENS = Number(process.env.AUTOCOMMIT_TOKENS || 120_000);
export const MIN_TURNS = Number(process.env.AUTOCOMMIT_MIN_TURNS || 25);
export const QUIET_MINUTES = Number(process.env.AUTOCOMMIT_QUIET_MINUTES || 60);

/**
 * Count real user-typed turns in a Claude Code session log — i.e. lines with
 * type "user" whose content is NOT purely tool_result blocks. Tool results are
 * also logged as role "user" internally, so a raw type==="user" line count
 * overcounts by including every tool call's result, not just what John typed.
 */
export async function countRealUserTurns(logPath: string): Promise<number> {
  let raw: string;
  try {
    raw = await fsp.readFile(logPath, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "user") continue;
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string") {
      count++;
      continue;
    }
    if (Array.isArray(content)) {
      const isPureToolResult =
        content.length > 0 &&
        content.every(
          (c) => c && typeof c === "object" && (c as Record<string, unknown>).type === "tool_result"
        );
      if (!isPureToolResult) count++;
    }
  }
  return count;
}

/**
 * The real, Anthropic-reported size of this session's current context —
 * read from the last turn's actual usage numbers in the session log, not
 * guessed from file size (confirmed 2026-07-13: raw-bytes/4 was a rough
 * heuristic; the log already contains the real figures Anthropic bills and
 * counts on every assistant turn).
 *
 * input_tokens (freshly processed) + cache_creation_input_tokens (newly
 * cached this turn) + cache_read_input_tokens (replayed from cache) together
 * are the full prompt size for that turn — for a --resume'd conversation,
 * that IS the whole conversation so far, so the most recent turn's total is
 * the current context size.
 */
export async function getCurrentContextTokens(logPath: string): Promise<number> {
  let raw: string;
  try {
    raw = await fsp.readFile(logPath, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const input = Number(usage.input_tokens ?? 0);
    const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
    const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
    return input + cacheCreate + cacheRead;
  }
  return 0;
}
