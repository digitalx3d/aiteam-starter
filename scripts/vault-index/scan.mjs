// Scanners: vault notes, project-repo docs, and Claude Code session logs.
//
// Everything here DERIVES rows from files on disk; nothing here ever writes
// markdown (auto-linking lives in autolink.mjs). Deleting the DB and
// re-running rebuild() must always reproduce the same state.

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parseFrontmatter, firstHeading } from "./fm.mjs";
import { upsertNote, replaceEdges, setMeta, getMeta } from "./db.mjs";

const VAULT_EXCLUDED_DIRS = new Set([".index", ".obsidian", ".git", "node_modules"]);

// Folder-based fallback when a note has no `type:` frontmatter.
const FOLDER_TYPE = {
  decisions: "decision",
  projects: "project",
  transcripts: "transcript",
  inbox: "inbox",
  "inbox-archive": "inbox",
  team: "team-context",
  agents: "agent-note",
  research: "research",
  warroom: "warroom",
};

const fwd = (p) => p.split(path.sep).join("/");
const stemOf = (p) => path.basename(p).replace(/\.md$/i, "");
const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------------------
// Link + tag extraction
// ---------------------------------------------------------------------------

/** Raw [[wikilink]] targets in a body (alias and #anchor stripped). */
export function extractWikilinks(body) {
  const out = [];
  const re = /\[\[([^\]\n]+)\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let target = m[1].split("|")[0].split("#")[0].trim();
    if (target) out.push(target);
  }
  return out;
}

/**
 * Tags = frontmatter `tags:` array plus inline #tags restricted to the
 * controlled vocabulary (project/, agent/, topic/) so stray hash marks in
 * code samples never pollute the index. Normalized without the leading #.
 */
export function extractTags(fm, body) {
  const tags = new Set();
  const fmTags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
  for (const t of fmTags) {
    const clean = String(t).replace(/^#/, "").trim();
    if (clean) tags.add(clean);
  }
  const re = /(^|[\s(])#((?:project|agent|topic)\/[A-Za-z0-9_/-]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) tags.add(m[2]);
  return [...tags];
}

// ---------------------------------------------------------------------------
// Wikilink resolver
// ---------------------------------------------------------------------------

/**
 * Resolver over the set of vault notes. Accepts targets like
 * "projects/my-app", "agents/maya/index", or a bare filename stem/title.
 */
export function makeResolver(entries) {
  // entries: [{ rel, title }]
  const byRel = new Map(); // lowercased rel-without-.md -> rel
  const byStem = new Map(); // lowercased stem -> [rel]
  const byTitle = new Map(); // lowercased title -> [rel]
  for (const e of entries) {
    const relNoExt = e.rel.replace(/\.md$/i, "").toLowerCase();
    byRel.set(relNoExt, e.rel);
    const stem = stemOf(e.rel).toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(e.rel);
    if (e.title) {
      const t = e.title.toLowerCase();
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(e.rel);
    }
  }
  return function resolve(target) {
    const t = target.replace(/\\/g, "/").replace(/^\//, "").replace(/\.md$/i, "").trim().toLowerCase();
    if (!t) return null;
    if (byRel.has(t)) return byRel.get(t);
    const last = t.split("/").pop();
    const stems = byStem.get(last);
    if (stems && stems.length === 1) return stems[0];
    const titles = byTitle.get(t);
    if (titles && titles.length === 1) return titles[0];
    return null; // ambiguous or unknown: leave unresolved
  };
}

/** Build a resolver from the DB (used for single-file updates by the watcher). */
export function makeDbResolver(db) {
  const rows = db
    .prepare("SELECT path, title FROM notes WHERE source = 'vault'")
    .all();
  return makeResolver(rows.map((r) => ({ rel: r.path, title: r.title })));
}

// ---------------------------------------------------------------------------
// Repo mapping (vault project slug <-> repo folder under projectsRoot)
// ---------------------------------------------------------------------------

/**
 * Priority per slug: .index/repo-map.json override > `repo:` frontmatter >
 * normalized-name match > most-frequent repo path mentioned in the note body.
 */
export function buildRepoMap(cfg, projectNotes, repoDirs) {
  let overrides = {};
  try {
    overrides = JSON.parse(
      fs.readFileSync(path.join(cfg.indexDir, "repo-map.json"), "utf8")
    );
  } catch {
    /* optional file */
  }
  const dirByNorm = new Map(repoDirs.map((d) => [normName(d), d]));
  const rootPattern = new RegExp(
    cfg.projectsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "[\\\\/]+([A-Za-z0-9._-]+)",
    "gi"
  );

  const slugToDir = {};
  for (const note of projectNotes) {
    const slug = stemOf(note.rel);
    if (typeof overrides[slug] === "string" && repoDirs.includes(overrides[slug])) {
      slugToDir[slug] = overrides[slug];
      continue;
    }
    const fmRepo = note.fm.repo || note.fm.repo_dir;
    if (typeof fmRepo === "string") {
      const base = path.basename(fmRepo.trim());
      if (repoDirs.includes(base)) {
        slugToDir[slug] = base;
        continue;
      }
    }
    const byName = dirByNorm.get(normName(slug));
    if (byName) {
      slugToDir[slug] = byName;
      continue;
    }
    const counts = new Map();
    let m;
    rootPattern.lastIndex = 0;
    while ((m = rootPattern.exec(note.body || "")) !== null) {
      const dir = m[1];
      if (dir.toLowerCase() === "vault") continue;
      const real = repoDirs.find((d) => d.toLowerCase() === dir.toLowerCase());
      if (real) counts.set(real, (counts.get(real) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) slugToDir[slug] = best[0];
  }

  const dirToSlug = {};
  for (const [slug, dir] of Object.entries(slugToDir)) dirToSlug[dir] = slug;
  return { slugToDir, dirToSlug };
}

export function saveRepoMap(db, repoMap) {
  setMeta(db, "repo_map", JSON.stringify(repoMap));
}

export function loadRepoMap(db) {
  try {
    return JSON.parse(getMeta(db, "repo_map")) || { slugToDir: {}, dirToSlug: {} };
  } catch {
    return { slugToDir: {}, dirToSlug: {} };
  }
}

/** Map an absolute cwd to a canonical project value (vault slug if known). */
export function projectFromCwd(cfg, repoMap, cwd) {
  if (!cwd) return null;
  const root = path.resolve(cfg.projectsRoot).toLowerCase() + path.sep;
  const resolved = path.resolve(cwd);
  if (!resolved.toLowerCase().startsWith(root)) return null;
  const seg = resolved.slice(root.length).split(path.sep)[0];
  if (!seg) return null;
  return repoMap.dirToSlug[seg] || seg;
}

/** Map a chat scope ("project:<dashboardSlug>") to a canonical project value. */
export function projectFromScope(repoMap, scope) {
  if (!scope || !scope.startsWith("project:")) return null;
  const dashSlug = scope.slice("project:".length);
  if (repoMap.dirToSlug[dashSlug]) return repoMap.dirToSlug[dashSlug];
  const hit = Object.keys(repoMap.slugToDir).find(
    (s) => normName(s) === normName(dashSlug)
  );
  return hit || dashSlug;
}

// ---------------------------------------------------------------------------
// Vault ingestion
// ---------------------------------------------------------------------------

async function* walkMarkdown(dir, rootDir, excludedDirs) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (excludedDirs.has(e.name) || e.name.startsWith(".")) continue;
      yield* walkMarkdown(path.join(dir, e.name), rootDir, excludedDirs);
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

const KNOWN_FM = new Set([
  "title", "type", "created", "updated", "project", "topic", "status",
  "severity", "agents", "scope", "session_id", "tags",
]);

/** Parse one vault file into { record, rawLinks, fm, body }. No DB writes. */
export function parseVaultFile(cfg, absPath, text, stat) {
  const rel = fwd(path.relative(cfg.vaultDir, absPath));
  const { fm, body } = parseFrontmatter(text);
  const folder = rel.includes("/") ? rel.split("/")[0] : "";
  const type =
    fm.type || FOLDER_TYPE[folder] || (rel === "README.md" ? "vault-root" : "note");
  const extra = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_FM.has(k)) extra[k] = v;
  }
  const record = {
    path: rel,
    source: "vault",
    abs_path: absPath,
    title: fm.title || firstHeading(body) || stemOf(rel),
    type,
    created: fm.created || null,
    updated: fm.updated || (stat ? new Date(stat.mtimeMs).toISOString() : null),
    project: fm.project || null,
    topic: fm.topic || null,
    status: fm.status || null,
    severity: fm.severity || null,
    agents: Array.isArray(fm.agents) ? fm.agents : fm.agents ? [fm.agents] : null,
    scope: fm.scope || null,
    session_id: fm.session_id || null,
    tags: extractTags(fm, body),
    body_len: Buffer.byteLength(body, "utf8"),
    mtime_ms: stat ? Math.round(stat.mtimeMs) : null,
    extra,
  };
  return { record, rawLinks: extractWikilinks(body), fm, body };
}

/** Compute the outgoing edges for a parsed vault note. */
export function vaultEdges(parsed, ctx) {
  const { record, rawLinks } = parsed;
  const { resolve, projectSlugs, sessionIds, repoMap } = ctx;
  const edges = [];
  const seen = new Set();
  const push = (dst, kind, resolved) => {
    const key = `${dst}\0${kind}`;
    if (dst && dst !== record.path && !seen.has(key)) {
      seen.add(key);
      edges.push({ dst, kind, resolved });
    }
  };

  for (const target of rawLinks) {
    const hit = resolve(target);
    push(hit || target, "link", Boolean(hit));
  }
  for (const tag of record.tags || []) push(`tag:${tag}`, "tag", true);

  // Derived project membership: frontmatter `project:`, project/<slug> tags,
  // and transcript scope all point at the canonical project note.
  const projectRefs = new Set();
  if (record.project) projectRefs.add(record.project);
  for (const tag of record.tags || []) {
    if (tag.startsWith("project/")) projectRefs.add(tag.slice("project/".length));
  }
  const scopeProject = projectFromScope(repoMap, record.scope);
  if (scopeProject) projectRefs.add(scopeProject);
  for (const slug of projectRefs) {
    if (projectSlugs.has(slug)) push(`projects/${slug}.md`, "project", true);
  }

  // Transcript -> raw Claude Code session log.
  if (record.session_id) {
    push(
      `session:${record.session_id}`,
      "session",
      sessionIds.has(record.session_id)
    );
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Repo docs ingestion
// ---------------------------------------------------------------------------

export async function listRepoDirs(cfg) {
  let entries;
  try {
    entries = await fsp.readdir(cfg.projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || e.name.startsWith("$")) continue;
    if (e.name.toLowerCase() === "vault") continue;
    const full = path.join(cfg.projectsRoot, e.name);
    const looksLikeProject = [".git", ".claude", "package.json", ".aiteam"].some(
      (marker) => fs.existsSync(path.join(full, marker))
    );
    if (looksLikeProject) dirs.push(e.name);
  }
  return dirs;
}

/** The bounded, high-signal doc set inside one repo. */
export async function listRepoDocs(cfg, repoDir) {
  const root = path.join(cfg.projectsRoot, repoDir);
  const docs = [];
  const addIfMd = async (abs) => {
    try {
      const stat = await fsp.stat(abs);
      if (stat.isFile()) docs.push({ abs, stat });
    } catch {
      /* missing */
    }
  };
  for (const name of ["README.md", "CLAUDE.md", "AGENTS.md"]) {
    await addIfMd(path.join(root, name));
  }
  const walkBounded = async (dir, depth) => {
    if (depth <= 0) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".git")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walkBounded(full, depth - 1);
      else if (e.isFile() && /\.md$/i.test(e.name)) await addIfMd(full);
    }
  };
  await walkBounded(path.join(root, "docs"), 3);
  await walkBounded(path.join(root, ".aiteam"), 2);
  return docs;
}

export async function ingestRepoDoc(cfg, db, repoDir, doc, repoMap, projectSlugs) {
  const root = path.join(cfg.projectsRoot, repoDir);
  const rel = fwd(path.relative(root, doc.abs));
  let text;
  try {
    text = await fsp.readFile(doc.abs, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = parseFrontmatter(text);
  const isTask = rel.startsWith(".aiteam/tasks/");
  const project = repoMap.dirToSlug[repoDir] || repoDir;
  const record = {
    path: `repo:${repoDir}/${rel}`,
    source: "repo",
    abs_path: doc.abs,
    title: fm.title || firstHeading(body) || stemOf(rel),
    type: fm.type || (isTask ? "task" : "repo-doc"),
    created: fm.created || null,
    updated: fm.updated || new Date(doc.stat.mtimeMs).toISOString(),
    project,
    status: fm.status || null,
    tags: extractTags(fm, ""),
    body_len: Buffer.byteLength(body, "utf8"),
    mtime_ms: Math.round(doc.stat.mtimeMs),
    extra: { repo_dir: repoDir, repo_rel: rel },
  };
  upsertNote(db, record);
  const edges = [];
  const slug = repoMap.dirToSlug[repoDir];
  if (slug && projectSlugs.has(slug)) {
    edges.push({ dst: `projects/${slug}.md`, kind: "project", resolved: true });
  }
  replaceEdges(db, record.path, edges);
  return record.path;
}

// ---------------------------------------------------------------------------
// Claude Code session-log ingestion
// ---------------------------------------------------------------------------

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const FULL_READ_MAX = 4 * 1024 * 1024;

function parseLines(chunk) {
  const out = [];
  for (const line of chunk.split("\n")) {
    const t = line.trim();
    if (!t || !t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* partial or malformed line */
    }
  }
  return out;
}

function textOfUserEntry(e) {
  if (e.type !== "user" || e.isSidechain) return null;
  const c = e.message?.content;
  let text = null;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    const t = c.find((b) => b?.type === "text");
    if (t) text = String(t.text ?? "");
  }
  if (!text) return null;
  const skip = ["[Auto-notify]", "<command-name>", "<local-command", "Caveat:", "<system-reminder"];
  if (skip.some((s) => text.startsWith(s))) return null;
  return text.replace(/\s+/g, " ").trim().slice(0, 140) || null;
}

async function readChunk(absPath, position, length) {
  const fh = await fsp.open(absPath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Parse one session .jsonl into a note record + edges. Returns null if unusable. */
export async function ingestSessionFile(cfg, db, absPath, stat, repoMap, projectSlugs) {
  const size = stat.size;
  if (size === 0) return null;

  let headEntries, fullText = null;
  if (size <= FULL_READ_MAX) {
    fullText = await fsp.readFile(absPath, "utf8");
    headEntries = parseLines(fullText);
  } else {
    headEntries = parseLines(await readChunk(absPath, 0, HEAD_BYTES));
  }

  let sessionId = null, cwd = null, firstTs = null, gitBranch = null,
    version = null, model = null, title = null;
  for (const e of headEntries) {
    if (!sessionId && e.sessionId) sessionId = e.sessionId;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!firstTs && e.timestamp) firstTs = e.timestamp;
    if (!gitBranch && e.gitBranch) gitBranch = e.gitBranch;
    if (!version && e.version) version = e.version;
    if (!model && e.message?.model) model = e.message.model;
    if (!title) title = textOfUserEntry(e);
    if (sessionId && cwd && firstTs && title && model) break;
  }
  if (!sessionId) sessionId = stemOf(absPath).replace(/\.jsonl$/i, "");

  let lastTs = null;
  let lineCount = null;
  if (fullText !== null) {
    lineCount = 0;
    for (let i = 0; i < fullText.length; i++) {
      if (fullText.charCodeAt(i) === 10) lineCount++;
    }
    const tailEntries = parseLines(fullText.slice(-TAIL_BYTES));
    for (let i = tailEntries.length - 1; i >= 0; i--) {
      if (tailEntries[i].timestamp) {
        lastTs = tailEntries[i].timestamp;
        break;
      }
    }
  } else {
    const tailEntries = parseLines(
      await readChunk(absPath, Math.max(0, size - TAIL_BYTES), TAIL_BYTES)
    );
    for (let i = tailEntries.length - 1; i >= 0; i--) {
      if (tailEntries[i].timestamp) {
        lastTs = tailEntries[i].timestamp;
        break;
      }
    }
  }

  const project = projectFromCwd(cfg, repoMap, cwd);
  const record = {
    path: `session:${sessionId}`,
    source: "session",
    abs_path: absPath,
    title: title || "(no user prompt captured)",
    type: "session",
    created: firstTs,
    updated: lastTs || new Date(stat.mtimeMs).toISOString(),
    project,
    session_id: sessionId,
    body_len: size,
    mtime_ms: Math.round(stat.mtimeMs),
    extra: {
      cwd,
      dir: path.basename(path.dirname(absPath)),
      line_count: lineCount,
      git_branch: gitBranch,
      model,
      cli_version: version,
    },
  };
  upsertNote(db, record);
  const edges = [];
  if (project && projectSlugs.has(project)) {
    edges.push({ dst: `projects/${project}.md`, kind: "project", resolved: true });
  }
  replaceEdges(db, record.path, edges);
  return record.path;
}

export async function listSessionFiles(cfg) {
  const out = [];
  let dirs;
  try {
    dirs = await fsp.readdir(cfg.claudeProjectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(cfg.claudeProjectsDir, d.name);
    let files;
    try {
      files = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && /\.jsonl$/i.test(f.name)) {
        out.push(path.join(dirPath, f.name));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full rebuild + incremental sweeps
// ---------------------------------------------------------------------------

/** Absolute paths of every indexable vault .md (no reads, just the walk). */
export async function listVaultFilePaths(cfg) {
  const out = [];
  for await (const abs of walkMarkdown(cfg.vaultDir, cfg.vaultDir, VAULT_EXCLUDED_DIRS)) {
    out.push(abs);
  }
  return out;
}

export async function scanVaultFiles(cfg) {
  const parsed = [];
  for await (const abs of walkMarkdown(cfg.vaultDir, cfg.vaultDir, VAULT_EXCLUDED_DIRS)) {
    try {
      const [text, stat] = await Promise.all([fsp.readFile(abs, "utf8"), fsp.stat(abs)]);
      parsed.push(parseVaultFile(cfg, abs, text, stat));
    } catch (err) {
      console.error(`[scan] skipping unreadable ${abs}: ${err.message}`);
    }
  }
  return parsed;
}

export function vaultContext(cfg, parsedFiles, sessionIds, repoDirs) {
  const projectNotes = parsedFiles
    .filter((p) => p.record.path.startsWith("projects/"))
    .map((p) => ({ rel: p.record.path, fm: p.fm, body: p.body }));
  const repoMap = buildRepoMap(cfg, projectNotes, repoDirs);
  const projectSlugs = new Set(projectNotes.map((n) => stemOf(n.rel)));
  const resolve = makeResolver(
    parsedFiles.map((p) => ({ rel: p.record.path, title: p.record.title }))
  );
  return { resolve, projectSlugs, sessionIds, repoMap };
}

export async function rebuild(cfg, db, { log = () => {} } = {}) {
  const startedAt = new Date().toISOString();

  log("scanning vault ...");
  const parsedFiles = await scanVaultFiles(cfg);
  const repoDirs = await listRepoDirs(cfg);

  log(`ingesting ${parsedFiles.length} vault notes ...`);
  const sessionFiles = await listSessionFiles(cfg);
  const sessionIds = new Set(
    sessionFiles.map((f) => stemOf(f).replace(/\.jsonl$/i, ""))
  );
  const ctx = vaultContext(cfg, parsedFiles, sessionIds, repoDirs);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM edges");
    db.exec("DELETE FROM notes");
    for (const p of parsedFiles) {
      upsertNote(db, p.record);
      replaceEdges(db, p.record.path, vaultEdges(p, ctx));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  log(`ingesting sessions from ${sessionFiles.length} logs ...`);
  let sessionCount = 0;
  db.exec("BEGIN");
  try {
    for (const f of sessionFiles) {
      try {
        const stat = await fsp.stat(f);
        if (await ingestSessionFile(cfg, db, f, stat, ctx.repoMap, ctx.projectSlugs)) {
          sessionCount++;
        }
      } catch (err) {
        console.error(`[scan] session skipped ${f}: ${err.message}`);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  log(`ingesting repo docs from ${repoDirs.length} repos ...`);
  let docCount = 0;
  db.exec("BEGIN");
  try {
    for (const repoDir of repoDirs) {
      for (const doc of await listRepoDocs(cfg, repoDir)) {
        try {
          if (await ingestRepoDoc(cfg, db, repoDir, doc, ctx.repoMap, ctx.projectSlugs)) {
            docCount++;
          }
        } catch (err) {
          console.error(`[scan] repo doc skipped ${doc.abs}: ${err.message}`);
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  saveRepoMap(db, ctx.repoMap);
  setMeta(db, "last_rebuild", startedAt);
  return {
    vaultNotes: parsedFiles.length,
    sessions: sessionCount,
    repoDocs: docCount,
    repoMap: ctx.repoMap,
  };
}

/** Re-ingest a single vault file (watcher path). Returns the note path or null. */
export async function ingestVaultFile(cfg, db, absPath) {
  let text, stat;
  try {
    [text, stat] = await Promise.all([fsp.readFile(absPath, "utf8"), fsp.stat(absPath)]);
  } catch {
    return null; // deleted between event and read
  }
  const parsed = parseVaultFile(cfg, absPath, text, stat);
  const repoMap = loadRepoMap(db);
  const projectSlugs = new Set(
    db.prepare("SELECT path FROM notes WHERE source='vault' AND path LIKE 'projects/%'")
      .all()
      .map((r) => stemOf(r.path))
  );
  if (parsed.record.path.startsWith("projects/")) {
    projectSlugs.add(stemOf(parsed.record.path));
  }
  const sessionIds = {
    has: (id) =>
      Boolean(db.prepare("SELECT 1 FROM notes WHERE path = ?").get(`session:${id}`)),
  };
  const resolve = makeDbResolver(db);
  upsertNote(db, parsed.record);
  replaceEdges(
    db,
    parsed.record.path,
    vaultEdges(parsed, { resolve, projectSlugs, sessionIds, repoMap })
  );
  return parsed.record.path;
}

/**
 * Incremental refresh of sessions + repo docs by mtime/size. Cheap enough to
 * run every few minutes; only changed files are re-read.
 */
export async function sweep(cfg, db, { log = () => {} } = {}) {
  const repoMap = loadRepoMap(db);
  const projectSlugs = new Set(
    db.prepare("SELECT path FROM notes WHERE source='vault' AND path LIKE 'projects/%'")
      .all()
      .map((r) => stemOf(r.path))
  );

  const known = new Map(
    db.prepare("SELECT path, abs_path, mtime_ms, body_len FROM notes WHERE source IN ('session','repo')")
      .all()
      .map((r) => [r.abs_path, r])
  );
  const seen = new Set();
  let changed = 0;

  db.exec("BEGIN");
  try {
    for (const f of await listSessionFiles(cfg)) {
      seen.add(f);
      let stat;
      try {
        stat = await fsp.stat(f);
      } catch {
        continue;
      }
      const prev = known.get(f);
      if (prev && prev.mtime_ms === Math.round(stat.mtimeMs) && prev.body_len === stat.size) continue;
      try {
        if (await ingestSessionFile(cfg, db, f, stat, repoMap, projectSlugs)) changed++;
      } catch (err) {
        console.error(`[sweep] session skipped ${f}: ${err.message}`);
      }
    }
    for (const repoDir of await listRepoDirs(cfg)) {
      for (const doc of await listRepoDocs(cfg, repoDir)) {
        seen.add(doc.abs);
        const prev = known.get(doc.abs);
        if (prev && prev.mtime_ms === Math.round(doc.stat.mtimeMs)) continue;
        try {
          if (await ingestRepoDoc(cfg, db, repoDir, doc, repoMap, projectSlugs)) changed++;
        } catch (err) {
          console.error(`[sweep] repo doc skipped ${doc.abs}: ${err.message}`);
        }
      }
    }
    // Files that vanished from disk leave the index too.
    let removed = 0;
    for (const [absPath, row] of known) {
      if (!seen.has(absPath)) {
        db.prepare("DELETE FROM edges WHERE src = ?").run(row.path);
        db.prepare("DELETE FROM notes WHERE path = ?").run(row.path);
        removed++;
      }
    }
    db.exec("COMMIT");
    setMeta(db, "last_sweep", new Date().toISOString());
    if (changed || removed) log(`sweep: ${changed} updated, ${removed} removed`);
    return { changed, removed };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
