// Auto-linking: fill the vault's link graph in deterministically as notes are
// written, so relatedness doesn't depend on every agent remembering to link.
//
// Safety contract (non-negotiable, from the build plan):
//   - NEVER rewrite note content. The only thing this module touches is a
//     clearly-marked, machine-owned footer block; everything outside the
//     markers stays byte-identical (verified by string splice, no reflow).
//   - ASCII only. Any candidate link/tag containing a non-ASCII byte is
//     dropped rather than written.
//   - Idempotent. Re-running produces the identical block, so no write.
//   - Deterministic matching only (slugs, titles, frontmatter fields) --
//     no model calls. If there is no confident match, the note is untouched.
//
// Tags are written inline (Obsidian treats inline #tags and frontmatter tags
// identically) because editing YAML frontmatter risks corrupting notes.

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./fm.mjs";
import { extractWikilinks, makeDbResolver } from "./scan.mjs";

export const BLOCK_START = "<!-- vault-auto-links -->";
export const BLOCK_END = "<!-- /vault-auto-links -->";

// Notes the auto-linker must never touch.
const SKIP_TYPES = new Set(["transcript", "rolling-summary", "vault-root"]);
const SKIP_PATH_PREFIXES = ["transcripts/", "agents/claude/summaries/"];
const MAX_FILE_BYTES = 300 * 1024;

// Agent first names safe to detect in prose. "claude" and "owner" appear in
// nearly every note, so they are only tagged when named in frontmatter.
const BODY_SCAN_AGENTS = ["maya", "devin", "casey", "ethan", "indy"];

const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);
const stemOf = (p) => path.basename(p).replace(/\.md$/i, "");

function wordMatch(haystackLower, term) {
  if (!term || term.length < 4) return false;
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`).test(haystackLower);
}

/** Candidate targets, read fresh from the index each run. */
export function loadCandidates(db) {
  const projects = db
    .prepare("SELECT path, title FROM notes WHERE source='vault' AND path LIKE 'projects/%'")
    .all()
    .map((r) => ({ path: r.path, slug: stemOf(r.path), title: r.title || "" }));
  const decisions = db
    .prepare("SELECT path, title, topic, project FROM notes WHERE source='vault' AND type='decision'")
    .all();
  return { projects, decisions };
}

/**
 * Compute the desired auto-link block for one note. Returns
 * { links: [...vault paths w/o .md], tags: [...] } (both sorted, ASCII-only).
 */
export function computeMatches(note, body, candidates) {
  const { projects, decisions } = candidates;
  // Match against content OUTSIDE any existing auto-block, plus the title.
  const searchable = (note.title + "\n" + stripBlock(body).text).toLowerCase();

  const matchedProjects = new Map(); // slug -> project
  const fmProjects = new Set();
  if (note.project) fmProjects.add(note.project);
  for (const tag of note.tags || []) {
    if (tag.startsWith("project/")) fmProjects.add(tag.slice("project/".length));
  }
  for (const p of projects) {
    if (
      fmProjects.has(p.slug) ||
      wordMatch(searchable, p.slug) ||
      wordMatch(searchable, p.title)
    ) {
      matchedProjects.set(p.slug, p);
    }
  }

  const matchedDecisions = [];
  for (const d of decisions) {
    if (d.path === note.path) continue;
    const sameProject = d.project && (matchedProjects.has(d.project) || fmProjects.has(d.project));
    const titleHit = d.title && d.title.length >= 12 && searchable.includes(d.title.toLowerCase());
    const topicHit = d.topic && d.topic.length >= 5 && wordMatch(searchable, d.topic);
    if (titleHit || (sameProject && topicHit)) matchedDecisions.push(d);
  }

  const tags = new Set();
  for (const slug of matchedProjects.keys()) tags.add(`project/${slug}`);
  if (note.topic) tags.add(`topic/${note.topic}`);
  const fmAgents = new Set(
    [...(note.agents || []), note.extra?.from].filter(Boolean).map((a) => String(a).toLowerCase())
  );
  fmAgents.delete("owner"); // The owner is the human, not an agent persona
  for (const a of fmAgents) tags.add(`agent/${a}`);
  for (const a of BODY_SCAN_AGENTS) {
    if (wordMatch(searchable, a)) tags.add(`agent/${a}`);
  }

  // Links already made by hand in the content stay the author's; only add
  // Related entries for targets not manually linked.
  const manualTargets = new Set();
  for (const raw of extractWikilinks(stripBlock(body).text)) {
    manualTargets.add(raw.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase());
  }
  const links = [];
  const pushLink = (vaultPath) => {
    const noExt = vaultPath.replace(/\.md$/i, "");
    if (noExt.toLowerCase() === note.path.replace(/\.md$/i, "").toLowerCase()) return;
    if (manualTargets.has(noExt.toLowerCase())) return;
    if (!isAscii(noExt)) return;
    links.push(noExt);
  };
  // Self-links are excluded inside pushLink, so cross-project Related links
  // (project overview A mentioning project B) are allowed and wanted.
  for (const p of matchedProjects.values()) pushLink(p.path);
  for (const d of matchedDecisions) pushLink(d.path);

  return {
    links: [...new Set(links)].sort(),
    tags: [...tags].filter(isAscii).sort(),
  };
}

/**
 * Remove the managed block from a document.
 * Returns { text, hadBlock, start, end } -- or { unsafe: true } when marker
 * text appears but cannot be confidently identified as OUR block, in which
 * case the caller must leave the file completely untouched.
 *
 * Hardening (learned the hard way): a note whose PROSE mentions the marker
 * string (e.g. documentation about this very feature) must never be parsed
 * as containing a block. Two guards:
 *   1. Markers only count at the start of a line.
 *   2. The block interior must consist solely of Related:/Tags:/blank lines.
 */
export function stripBlock(text) {
  const atLineStart = (marker, from = 0) => {
    let idx = text.indexOf(marker, from);
    while (idx !== -1) {
      if (idx === 0 || text[idx - 1] === "\n") return idx;
      idx = text.indexOf(marker, idx + 1);
    }
    return -1;
  };
  const start = atLineStart(BLOCK_START);
  if (start === -1) {
    // No block -- but if marker text appears anywhere mid-line, appending a
    // new block is still safe (we only ever strip line-start markers).
    return { text, hadBlock: false };
  }
  const endMarker = atLineStart(BLOCK_END, start);
  if (endMarker === -1) return { text, hadBlock: false, unsafe: true };
  const interior = text.slice(start + BLOCK_START.length, endMarker);
  const interiorOk = interior
    .split("\n")
    .every((l) => /^(\s*|Related:.*|Tags:.*)\r?$/.test(l));
  if (!interiorOk) return { text, hadBlock: false, unsafe: true };
  const end = endMarker + BLOCK_END.length;
  return {
    text: text.slice(0, start) + text.slice(end),
    hadBlock: true,
    start,
    end,
  };
}

function renderBlock(matches, eol) {
  const lines = [BLOCK_START];
  if (matches.links.length) {
    lines.push("Related: " + matches.links.map((l) => `[[${l}]]`).join(", "));
  }
  if (matches.tags.length) {
    lines.push("Tags: " + matches.tags.map((t) => `#${t}`).join(" "));
  }
  lines.push(BLOCK_END);
  return lines.join(eol);
}

/**
 * Apply auto-linking to one vault file on disk.
 * Returns { status: 'skipped'|'unchanged'|'updated'|'removed', block? }.
 * With dryRun, computes and returns what WOULD be written without writing.
 */
export async function autolinkFile(cfg, db, absPath, { dryRun = false } = {}) {
  const rel = path.relative(cfg.vaultDir, absPath).split(path.sep).join("/");
  for (const prefix of SKIP_PATH_PREFIXES) {
    if (rel.startsWith(prefix)) return { status: "skipped", reason: "path" };
  }
  if (rel === "README.md") return { status: "skipped", reason: "path" };

  let text, stat;
  try {
    [text, stat] = await Promise.all([fsp.readFile(absPath, "utf8"), fsp.stat(absPath)]);
  } catch {
    return { status: "skipped", reason: "unreadable" };
  }
  if (stat.size > MAX_FILE_BYTES) return { status: "skipped", reason: "too-large" };

  const { fm, body } = parseFrontmatter(text);
  const note = db.prepare("SELECT * FROM notes WHERE path = ?").get(rel);
  const type = fm.type || note?.type || null;
  if (type && SKIP_TYPES.has(type)) return { status: "skipped", reason: `type:${type}` };

  // Prefer the freshly-read file over possibly-stale DB row for matching input.
  const noteView = {
    path: rel,
    title: fm.title || (note?.title ?? stemOf(rel)),
    project: fm.project || null,
    topic: fm.topic || null,
    agents: Array.isArray(fm.agents) ? fm.agents : fm.agents ? [fm.agents] : [],
    tags: Array.isArray(fm.tags) ? fm.tags.map((t) => String(t).replace(/^#/, "")) : [],
    extra: { from: fm.from },
  };

  const candidates = loadCandidates(db);
  const matches = computeMatches(noteView, body, candidates);
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const hasContent = matches.links.length > 0 || matches.tags.length > 0;

  const stripped = stripBlock(text);
  if (stripped.unsafe) return { status: "skipped", reason: "ambiguous-marker" };
  let next;
  if (!hasContent) {
    if (!stripped.hadBlock) return { status: "unchanged" };
    // Matches disappeared: remove the stale block (trim the padding we added).
    next = stripped.text.replace(/(\r?\n)+$/, eol);
    if (next === text) return { status: "unchanged" };
    if (!dryRun) await fsp.writeFile(absPath, next, "utf8");
    return { status: "removed" };
  }

  const block = renderBlock(matches, eol);
  if (stripped.hadBlock) {
    // Replace in place: everything before/after the old block is untouched.
    next = text.slice(0, stripped.start) + block + text.slice(stripped.end);
  } else {
    const base = text.replace(/(\r?\n)*$/, "");
    next = base + eol + eol + block + eol;
  }
  if (next === text) return { status: "unchanged" };
  if (!dryRun) await fsp.writeFile(absPath, next, "utf8");
  return { status: "updated", block };
}

/** Run auto-linking across every eligible vault note. */
export async function autolinkAll(cfg, db, { dryRun = false, log = () => {} } = {}) {
  const rows = db
    .prepare("SELECT path, abs_path FROM notes WHERE source = 'vault'")
    .all();
  const results = { updated: [], removed: [], unchanged: 0, skipped: 0 };
  for (const r of rows) {
    if (!r.abs_path || !fs.existsSync(r.abs_path)) continue;
    const res = await autolinkFile(cfg, db, r.abs_path, { dryRun });
    if (res.status === "updated") {
      results.updated.push(r.path);
      log(`${dryRun ? "[dry] " : ""}autolink updated ${r.path}`);
    } else if (res.status === "removed") {
      results.removed.push(r.path);
    } else if (res.status === "unchanged") results.unchanged++;
    else results.skipped++;
  }
  return results;
}

// Re-export for the watcher's self-write suppression.
export { makeDbResolver };
