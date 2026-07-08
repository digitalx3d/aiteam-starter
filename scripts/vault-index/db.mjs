// SQLite access for the vault index.
//
// Driver: node:sqlite (built into Node >= 22.5). Chosen over better-sqlite3
// because it needs no npm install and no native compile step on Windows --
// these scripts must run standalone from any agent's Bash context, without
// the app's node_modules. It is marked experimental upstream, which is an
// acceptable trade for a derived, always-rebuildable index (ground rule:
// markdown stays the source of truth).
//
// The experimental warning node prints on first use is suppressed below
// (before the module loads) so agents parsing CLI output don't see noise.

process.removeAllListeners("warning");
process.on("warning", (w) => {
  // Keep every warning EXCEPT the known node:sqlite experimental notice.
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  console.error(`${w.name}: ${w.message}`);
});

const { DatabaseSync } = await import("node:sqlite");

import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  path        TEXT PRIMARY KEY,   -- canonical id: vault-relative path | repo:<Dir>/<relpath> | session:<uuid>
  source      TEXT NOT NULL,      -- vault | repo | session
  abs_path    TEXT,               -- absolute path on disk
  title       TEXT,
  type        TEXT,               -- decision | project | transcript | inbox | agent-index | team-context | repo-doc | session | ...
  created     TEXT,               -- ISO8601
  updated     TEXT,
  project     TEXT,               -- canonical vault project slug where known (else repo folder name)
  topic       TEXT,
  status      TEXT,
  severity    TEXT,
  agents      TEXT,               -- JSON array
  scope       TEXT,               -- transcripts + sessions: default | project:<slug> | external
  session_id  TEXT,
  tags        TEXT,               -- JSON array of normalized tags (no #)
  body_len    INTEGER,            -- bytes of body (vault/repo) or file size (session)
  mtime_ms    INTEGER,            -- source-file mtime, for incremental sweeps
  indexed_at  TEXT,
  extra       TEXT                -- JSON: everything else (from, priority, filed, message_count, cwd, git_branch, ...)
);

CREATE TABLE IF NOT EXISTS edges (
  src      TEXT NOT NULL,
  dst      TEXT NOT NULL,         -- resolved note path, tag:<tag>, or raw target when unresolved
  kind     TEXT NOT NULL,         -- link | tag | project | session
  resolved INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (src, dst, kind)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_project  ON notes(project);
CREATE INDEX IF NOT EXISTS idx_notes_type     ON notes(type);
CREATE INDEX IF NOT EXISTS idx_notes_severity ON notes(severity);
CREATE INDEX IF NOT EXISTS idx_notes_updated  ON notes(updated);
CREATE INDEX IF NOT EXISTS idx_notes_source   ON notes(source);
CREATE INDEX IF NOT EXISTS idx_edges_dst      ON edges(dst);
`;

export function openDb(dbPath, { readonly = false } = {}) {
  if (readonly && !fs.existsSync(dbPath)) {
    throw new Error(
      `Index not found at ${dbPath}. Run: node scripts/vault-indexer.mjs rebuild`
    );
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { readOnly: readonly });
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)"
    ).run(String(SCHEMA_VERSION));
  } else {
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  return db;
}

/** Wipe all indexed data (keeps the file + schema; safe while others hold the DB open). */
export function wipe(db) {
  db.exec("BEGIN");
  db.exec("DELETE FROM edges");
  db.exec("DELETE FROM notes");
  db.exec("COMMIT");
}

export function setMeta(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    key,
    String(value)
  );
}

export function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function upsertNote(db, n) {
  db.prepare(
    `INSERT INTO notes (path, source, abs_path, title, type, created, updated,
       project, topic, status, severity, agents, scope, session_id, tags,
       body_len, mtime_ms, indexed_at, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       source=excluded.source, abs_path=excluded.abs_path, title=excluded.title,
       type=excluded.type, created=excluded.created, updated=excluded.updated,
       project=excluded.project, topic=excluded.topic, status=excluded.status,
       severity=excluded.severity, agents=excluded.agents, scope=excluded.scope,
       session_id=excluded.session_id, tags=excluded.tags,
       body_len=excluded.body_len, mtime_ms=excluded.mtime_ms,
       indexed_at=excluded.indexed_at, extra=excluded.extra`
  ).run(
    n.path,
    n.source,
    n.abs_path ?? null,
    n.title ?? null,
    n.type ?? null,
    n.created ?? null,
    n.updated ?? null,
    n.project ?? null,
    n.topic ?? null,
    n.status ?? null,
    n.severity ?? null,
    n.agents ? JSON.stringify(n.agents) : null,
    n.scope ?? null,
    n.session_id ?? null,
    n.tags && n.tags.length ? JSON.stringify(n.tags) : null,
    n.body_len ?? null,
    n.mtime_ms ?? null,
    n.indexed_at ?? new Date().toISOString(),
    n.extra && Object.keys(n.extra).length ? JSON.stringify(n.extra) : null
  );
}

/** Replace all outgoing edges for a source note. */
export function replaceEdges(db, src, edges) {
  db.prepare("DELETE FROM edges WHERE src = ?").run(src);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO edges (src, dst, kind, resolved) VALUES (?, ?, ?, ?)"
  );
  for (const e of edges) ins.run(src, e.dst, e.kind, e.resolved ? 1 : 0);
}

export function deleteNote(db, notePath) {
  db.prepare("DELETE FROM edges WHERE src = ?").run(notePath);
  db.prepare("DELETE FROM notes WHERE path = ?").run(notePath);
}
