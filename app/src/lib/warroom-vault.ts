import path from "node:path";
import { promises as fsp } from "node:fs";
import { execFile } from "node:child_process";
import { getConfig } from "./config";

/**
 * Vault grounding for the War Room: keyword-search the vault's SQLite index
 * (via scripts/vault-query.mjs, read-only) for notes related to the topic, and
 * build a shared-background block the whole room sees in Round 1. Everything
 * here is best-effort — a missing index, script, or note file just means the
 * session runs without grounding.
 */

export interface VaultContextNote {
  path: string;
  title: string;
}

export interface VaultContext {
  /** Prompt-ready background block (already capped in size). */
  text: string;
  /** The notes it was built from, for the facilitator's "I pulled..." bubble. */
  notes: VaultContextNote[];
}

interface VaultHit {
  path: string;
  title: string;
  type: string;
  project: string;
  updated: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "have", "what",
  "should", "would", "could", "about", "into", "over", "when", "where",
  "how", "why", "our", "your", "their", "them", "then", "than", "each",
  "want", "need", "like", "just", "some", "more", "most", "make", "made",
  "making", "build", "building", "idea", "ideas", "plan", "plans", "list",
  "brief", "simple", "good", "best", "team", "every", "each", "also",
  "will", "can", "get", "one", "two", "three", "way", "ways", "thing",
  "things", "give", "back", "come", "look", "explanation", "explanations",
]);

function extractKeywords(text: string, cap = 8): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= cap) break;
  }
  return out;
}

function searchOnce(term: string): Promise<VaultHit[]> {
  return new Promise((resolve) => {
    const cfg = getConfig();
    const script = path.join(cfg.aiteamDir, "scripts", "vault-query.mjs");
    execFile(
      process.execPath,
      [script, "search", term, "--json", "--limit", "10"],
      { cwd: cfg.aiteamDir, timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const rows = JSON.parse(stdout) as VaultHit[];
          resolve(Array.isArray(rows) ? rows : []);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

/** Strip frontmatter and clip a note body down to an excerpt. */
function excerpt(raw: string, maxChars: number): string {
  let body = raw;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4);
  }
  body = body.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length > maxChars) body = body.slice(0, maxChars).trimEnd() + " ...";
  return body;
}

/**
 * Build the shared background block for a session. Notes are scored by how
 * many topic keywords match them (ties broken by recency), top 4 win.
 * Returns null when there's nothing relevant or the index isn't available.
 */
export async function buildVaultContext(
  idea: string,
  objective: string
): Promise<VaultContext | null> {
  const keywords = extractKeywords(`${idea} ${objective}`);
  if (keywords.length === 0) return null;

  const resultSets = await Promise.all(keywords.map(searchOnce));
  const scored = new Map<string, { hit: VaultHit; score: number }>();
  for (const rows of resultSets) {
    for (const hit of rows) {
      if (!hit?.path) continue;
      const entry = scored.get(hit.path);
      if (entry) entry.score += 1;
      else scored.set(hit.path, { hit, score: 1 });
    }
  }
  if (scored.size === 0) return null;

  const top = [...scored.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(b.hit.updated).localeCompare(String(a.hit.updated))
    )
    .slice(0, 4);

  const vaultDir = getConfig().vaultDir;
  const sections: string[] = [];
  const notes: VaultContextNote[] = [];
  for (const { hit } of top) {
    try {
      const file = path.join(vaultDir, hit.path.replace(/\//g, path.sep));
      const raw = await fsp.readFile(file, "utf8");
      const body = excerpt(raw, 900);
      if (!body) continue;
      sections.push(`### ${hit.title || hit.path}\n${body}`);
      notes.push({ path: hit.path, title: hit.title || hit.path });
    } catch {
      /* note file missing or unreadable — skip it */
    }
  }
  if (sections.length === 0) return null;

  let text = sections.join("\n\n");
  if (text.length > 4200) text = text.slice(0, 4200).trimEnd() + " ...";
  return { text, notes };
}
