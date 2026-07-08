import path from "node:path";
import { promises as fsp } from "node:fs";

/**
 * Parses a dispatched worker's teed stream-json transcript
 * (app/.dispatches/<ticketId>.jsonl) into an ORDERED, interleaved feed of the
 * agent's reasoning text and tool actions — the data behind the Agents tab's
 * live "watch them work" feed (Level B).
 *
 * Stream-json shape: each `assistant` event carries a single content block
 * (thinking | text | tool_use), emitted in order as the turn streams; each
 * `user` event carries tool_result blocks. We walk the file in order, keep the
 * text + tool_use blocks (thinking is internal/usually empty — skipped), and
 * attach each tool_result to its tool_use by id.
 */

export type FeedEntry =
  | { kind: "text"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result?: string;
      resultIsError?: boolean;
    };

const DISPATCHES_DIR = path.join(process.cwd(), ".dispatches");
const MAX_STR = 4000; // cap any single input/result string
const MAX_ENTRIES = 400; // only surface the most recent N entries

function clip(s: string): string {
  return s.length <= MAX_STR ? s : s.slice(0, MAX_STR) + "\n… (truncated)";
}

/** Clip string values inside a tool input object so the poll payload stays small. */
function clipInput(input: unknown): unknown {
  if (typeof input === "string") return clip(input);
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = typeof v === "string" ? clip(v) : v;
    }
    return out;
  }
  return input;
}

function stringifyContent(content: unknown): string {
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

export async function parseTranscript(ticketId: string): Promise<FeedEntry[]> {
  // Guard: ticket ids are uuids. Reject anything else (no path traversal).
  if (!/^[a-zA-Z0-9-]+$/.test(ticketId)) return [];
  const p = path.join(DISPATCHES_DIR, `${ticketId}.jsonl`);
  let raw: string;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch {
    return [];
  }

  const entries: FeedEntry[] = [];
  const toolIndexById = new Map<string, number>();
  let textSeq = 0;
  let lastText = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const message = obj.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    if (obj.type === "assistant") {
      for (const c of content as Array<Record<string, unknown>>) {
        if (c?.type === "text" && typeof c.text === "string") {
          const text = c.text.trim();
          if (!text || text === lastText) continue; // skip empty / consecutive dupes
          lastText = text;
          entries.push({ kind: "text", id: `txt-${textSeq++}`, text: clip(text) });
        } else if (c?.type === "tool_use" && typeof c.id === "string") {
          lastText = ""; // let identical narration after a tool still show
          const existing = toolIndexById.get(c.id);
          if (existing !== undefined) {
            const e = entries[existing];
            if (e.kind === "tool") {
              e.name = String(c.name ?? "");
              e.input = clipInput(c.input ?? {});
            }
          } else {
            toolIndexById.set(c.id, entries.length);
            entries.push({
              kind: "tool",
              id: c.id,
              name: String(c.name ?? ""),
              input: clipInput(c.input ?? {}),
            });
          }
        }
      }
    } else if (obj.type === "user") {
      for (const c of content as Array<Record<string, unknown>>) {
        if (c?.type === "tool_result" && typeof c.tool_use_id === "string") {
          const i = toolIndexById.get(c.tool_use_id);
          if (i !== undefined) {
            const e = entries[i];
            if (e.kind === "tool") {
              e.result = clip(stringifyContent(c.content));
              e.resultIsError = Boolean(c.is_error);
            }
          }
        }
      }
    }
  }

  return entries.slice(-MAX_ENTRIES);
}
