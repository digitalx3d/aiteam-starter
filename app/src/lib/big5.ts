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

export async function writeBig5(data: Big5Data): Promise<void> {
  const md = serializeBig5(data);
  await fsp.writeFile(big5Path(), md, "utf8");
}
