import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig } from "./config";

/**
 * Decision auto-promotion (short-term memory Priority 2, approved 2026-07-02).
 *
 * The distillation call emits, alongside the primer, a JSON array of decisions
 * newly made in the session. This module validates them and writes structured
 * `vault/decisions/*.md` files per the vault frontmatter contract, so the
 * SQLite index and link graph stay fed without a human writing the files.
 *
 * Guardrails:
 *  - ASCII-only writes (the vault build pipeline corrupts non-ASCII).
 *  - Never overwrite: an existing file or an existing decision with the same
 *    normalized title is skipped, not replaced.
 *  - Provenance: `distilled_by` + `promoted_from` + an `auto-promoted` tag so
 *    hand-written and promoted decisions stay distinguishable and CVB can
 *    triage promotions in his weekly pass.
 *  - Failures here must never break the primer write (callers isolate).
 */

export interface ExistingDecision {
  title: string;
  project: string | null;
  topic: string | null;
}

interface PromotedDecision {
  title: string;
  project: string;
  topic: string;
  severity: "low" | "medium" | "high";
  status: string;
  agents: string[];
  body: string;
}

/** Transliterate the common offenders, then drop anything still non-ASCII. */
export function toAscii(s: string): string {
  return s
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x00-\x7F]/g, "");
}

function slugify(title: string): string {
  return toAscii(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function decisionsDir(): string {
  return path.join(getConfig().vaultDir, "decisions");
}

/** Minimal frontmatter scan of vault/decisions/ for the dedup list. */
export async function listExistingDecisions(): Promise<ExistingDecision[]> {
  let files: string[];
  try {
    files = await fsp.readdir(decisionsDir());
  } catch {
    return [];
  }
  const out: ExistingDecision[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    try {
      const raw = await fsp.readFile(path.join(decisionsDir(), f), "utf8");
      const head = raw.slice(0, 2000);
      const grab = (key: string) =>
        head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
      const title = grab("title");
      if (title) {
        out.push({ title, project: grab("project"), topic: grab("topic") });
      }
    } catch {
      /* unreadable file: not fatal */
    }
  }
  return out;
}

function normalizeEntry(raw: unknown): PromotedDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? toAscii(r.title).trim() : "";
  const body = typeof r.body === "string" ? toAscii(r.body).trim() : "";
  if (title.length < 5 || body.length < 20) return null;
  const severity = ["low", "medium", "high"].includes(r.severity as string)
    ? (r.severity as PromotedDecision["severity"])
    : "medium";
  const agents = Array.isArray(r.agents)
    ? r.agents.filter((a): a is string => typeof a === "string").map((a) => toAscii(a).toLowerCase()).filter(Boolean)
    : [];
  return {
    title: title.slice(0, 120),
    project: typeof r.project === "string" ? toAscii(r.project).toLowerCase().trim() || "team" : "team",
    topic: typeof r.topic === "string" ? slugify(r.topic) || "general" : "general",
    severity,
    status: typeof r.status === "string" && toAscii(r.status).trim() ? toAscii(r.status).trim() : "active",
    agents: agents.length ? agents : ["claude"],
    body,
  };
}

/**
 * Parse the model's decisions JSON (tolerantly) and write one file per new
 * decision. Returns what was written/skipped for the caller's log line.
 */
export async function promoteDecisions(
  rawJson: string,
  meta: { scope: string; transcriptPath?: string | null }
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];

  const start = rawJson.indexOf("[");
  const end = rawJson.lastIndexOf("]");
  if (start === -1 || end <= start) return { written, skipped };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson.slice(start, end + 1));
  } catch {
    skipped.push("(unparseable decisions JSON)");
    return { written, skipped };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { written, skipped };

  const existing = await listExistingDecisions();
  const existingTitles = new Set(existing.map((d) => d.title.toLowerCase().trim()));

  const now = new Date();
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const day = iso.slice(0, 10);

  for (const raw of parsed.slice(0, 8)) {
    const d = normalizeEntry(raw);
    if (!d) {
      skipped.push("(invalid entry)");
      continue;
    }
    if (existingTitles.has(d.title.toLowerCase().trim())) {
      skipped.push(`${d.title} (title already recorded)`);
      continue;
    }
    const file = `${day}-${slugify(d.title)}.md`;
    const abs = path.join(decisionsDir(), file);
    try {
      await fsp.access(abs);
      skipped.push(`${file} (file exists)`);
      continue;
    } catch {
      /* not there: good */
    }

    const lines = [
      "---",
      `title: ${d.title}`,
      "type: decision",
      `created: ${iso}`,
      `updated: ${iso}`,
      `project: ${d.project}`,
      `agents: [${d.agents.join(", ")}]`,
      `topic: ${d.topic}`,
      `status: ${d.status}`,
      `severity: ${d.severity}`,
      "distilled_by: claude-von-braun",
      ...(meta.transcriptPath ? [`promoted_from: ${toAscii(meta.transcriptPath)}`] : []),
      "tags: [auto-promoted]",
      "---",
      "",
      `# ${d.title}`,
      "",
      d.body,
      "",
      `> Auto-promoted from the ${toAscii(meta.scope)} session ended ${day}. Review in weekly triage.`,
      "",
    ];
    const doc = lines.join("\n");
    if (!/^[\x00-\x7F]*$/.test(doc)) {
      skipped.push(`${file} (non-ASCII after sanitize)`);
      continue;
    }
    try {
      await fsp.mkdir(decisionsDir(), { recursive: true });
      await fsp.writeFile(abs, doc, "utf8");
      written.push(file);
      existingTitles.add(d.title.toLowerCase().trim());
    } catch (err) {
      skipped.push(`${file} (write failed: ${(err as Error).message})`);
    }
  }
  return { written, skipped };
}
