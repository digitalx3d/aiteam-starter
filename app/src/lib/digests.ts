import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig } from "./config";

function digestsDir(): string {
  return path.join(getConfig().vaultDir, "agents", "indy", "digests");
}

export interface DigestSummary {
  /** ISO date like "2026-05-18" (the filename stem). */
  date: string;
  title: string;
  period?: string;
  sources?: string;
  /** Short teaser pulled from frontmatter `summary` if present. */
  summary?: string;
}

export interface DigestFull extends DigestSummary {
  /** Markdown body, frontmatter stripped. */
  body: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (k) meta[k] = v;
  }
  return { meta, body: match[2].trimStart() };
}

export async function listDigests(): Promise<DigestSummary[]> {
  const dir = digestsDir();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: DigestSummary[] = [];
  for (const f of entries) {
    if (!f.endsWith(".md")) continue;
    if (f.startsWith(".")) continue;
    const date = f.slice(0, -3);
    try {
      const raw = await fsp.readFile(path.join(dir, f), "utf8");
      const { meta } = parseFrontmatter(raw);
      out.push({
        date,
        title: meta.title ?? `Digest ${date}`,
        period: meta.period,
        sources: meta.sources,
        summary: meta.summary,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export async function readDigest(date: string): Promise<DigestFull | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const filePath = path.join(digestsDir(), `${date}.md`);
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    return {
      date,
      title: meta.title ?? `Digest ${date}`,
      period: meta.period,
      sources: meta.sources,
      summary: meta.summary,
      body,
    };
  } catch {
    return null;
  }
}
