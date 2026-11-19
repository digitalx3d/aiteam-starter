import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig, getOwnerName } from "./config";

function big5Path(): string {
  return path.join(getConfig().aiteamDir, "big5.md");
}

export interface Big5Item {
  text: string;
  done: boolean;
}

export interface CompletedItem {
  text: string;
  /** ISO date string, e.g. "2026-05-08" */
  completedAt: string;
}

export interface Big5Data {
  active: Big5Item[];
  completed: CompletedItem[];
}

const TASK_LINE = /^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/;
const COMPLETED_LINE =
  /^\s*-\s+(\d{4}-\d{2}-\d{2})\s+·\s+(.+?)\s*$/;

export function parseBig5(md: string): Big5Data {
  const active: Big5Item[] = [];
  const completed: CompletedItem[] = [];
  if (!md) return { active, completed };
  for (const line of md.split("\n")) {
    const t = line.match(TASK_LINE);
    if (t) {
      active.push({
        done: t[1].toLowerCase() === "x",
        text: t[2].trim(),
      });
      continue;
    }
    const c = line.match(COMPLETED_LINE);
    if (c) {
      completed.push({
        completedAt: c[1],
        text: c[2].trim(),
      });
    }
  }
  return { active, completed };
}

export function serializeBig5(data: Big5Data): string {
  let out =
    "# Big 5\n\n" +
    `${getOwnerName().first}'s top-of-mind priorities (up to 5). Editable from the Dashboard.\n\n`;

  const activeLines = data.active
    .filter((it) => it.text.trim().length > 0)
    .map((it) => `- [${it.done ? "x" : " "}] ${it.text.trim()}`);
  if (activeLines.length > 0) {
    out += activeLines.join("\n") + "\n";
  }

  const validCompleted = data.completed.filter(
    (c) => c.text.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(c.completedAt)
  );
  if (validCompleted.length > 0) {
    // Newest first — descending by date.
    const sorted = [...validCompleted].sort((a, b) =>
      b.completedAt.localeCompare(a.completedAt)
    );
    out += "\n## Recently completed\n\n";
    out +=
      sorted.map((c) => `- ${c.completedAt} · ${c.text.trim()}`).join("\n") +
      "\n";
  }

  return out;
}

export async function readBig5(): Promise<Big5Data> {
  let raw = "";
  try {
    raw = await fsp.readFile(big5Path(), "utf8");
  } catch {
    /* missing — return empty */
  }
  return parseBig5(raw);
}

/**
 * A stamp identifying the version of the file a client is looking at.
 *
 * The card edits by sending the WHOLE list back, so a tab that loaded an hour
 * ago will happily overwrite anything written since with its stale copy. That
 * is not hypothetical: on 2026-08-18 an open tab wiped a priority that had been
 * added to the file minutes earlier, and the only symptom was the item quietly
 * not being there. Callers pass this back on write; a mismatch is refused.
 */
export async function big5Revision(): Promise<string> {
  try {
    const stat = await fsp.stat(big5Path());
    return String(stat.mtimeMs);
  } catch {
    return "0"; // no file yet — any write is the first
  }
}

export class Big5ConflictError extends Error {
  constructor(public current: Big5Data, public revision: string) {
    super("big5.md changed since this copy was loaded");
  }
}

/**
 * Write the list, refusing if the file moved on since `expectedRevision`.
 * Omitting the revision keeps the old last-write-wins behaviour, which is what
 * a script editing the file directly wants.
 */
export async function writeBig5(
  data: Big5Data,
  expectedRevision?: string
): Promise<string> {
  if (expectedRevision !== undefined) {
    const current = await big5Revision();
    if (current !== expectedRevision) {
      throw new Big5ConflictError(await readBig5(), current);
    }
  }
  const md = serializeBig5(data);
  await fsp.writeFile(big5Path(), md, "utf8");
  return big5Revision();
}
