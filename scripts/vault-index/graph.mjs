// Programmatic graph traversal over the edges table (Workstream 2b).
//
// Tag nodes (dst = "tag:project/x") are returned as neighbors but not
// expanded during multi-hop traversal by default -- expanding through a tag
// connects every note sharing it, which turns 2-hop results into "the whole
// project". Pass throughTags: true when that IS the question.

/**
 * Resolve a user-supplied note reference (path with/without .md, bare stem,
 * title, session id) to a canonical notes.path. Returns null when ambiguous
 * or unknown.
 */
export function resolveNoteRef(db, ref) {
  const r = String(ref).trim().replace(/\\/g, "/");
  const exact = db.prepare("SELECT path FROM notes WHERE path = ?").get(r);
  if (exact) return exact.path;
  const withMd = db.prepare("SELECT path FROM notes WHERE path = ?").get(`${r}.md`);
  if (withMd) return withMd.path;
  if (/^[0-9a-f-]{36}$/i.test(r)) {
    const bySession = db
      .prepare("SELECT path FROM notes WHERE session_id = ?")
      .get(r);
    if (bySession) return bySession.path;
  }
  const stem = r.toLowerCase().replace(/\.md$/, "");
  const byStem = db
    .prepare(
      `SELECT path FROM notes
       WHERE LOWER(path) LIKE '%/' || ? || '.md' OR LOWER(path) = ? || '.md'
       LIMIT 3`
    )
    .all(stem, stem);
  if (byStem.length === 1) return byStem[0].path;
  const byTitle = db
    .prepare("SELECT path FROM notes WHERE LOWER(title) = ? LIMIT 3")
    .all(r.toLowerCase());
  if (byTitle.length === 1) return byTitle[0].path;
  return null;
}

/** Direct neighborhood: every edge touching the note, both directions. */
export function neighbors(db, notePath) {
  const rows = db
    .prepare(
      `SELECT src, dst, kind, resolved FROM edges WHERE src = ? OR dst = ?`
    )
    .all(notePath, notePath);
  return rows.map((r) => ({
    other: r.src === notePath ? r.dst : r.src,
    direction: r.src === notePath ? "out" : "in",
    kind: r.kind,
    resolved: Boolean(r.resolved),
  }));
}

/**
 * BFS out to n hops. Returns [{ path, depth, via, kind }] sorted by depth,
 * excluding the start node.
 */
export function nHop(db, startPath, n, { throughTags = false } = {}) {
  const visited = new Map([[startPath, 0]]);
  const out = [];
  let frontier = [startPath];
  for (let depth = 1; depth <= n && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      if (node.startsWith("tag:") && !throughTags) continue;
      for (const nb of neighbors(db, node)) {
        if (visited.has(nb.other)) continue;
        visited.set(nb.other, depth);
        out.push({ path: nb.other, depth, via: node, kind: nb.kind });
        next.push(nb.other);
      }
    }
    frontier = next;
  }
  return out;
}

/** Inbound references only ("which notes point at this one"). */
export function backlinks(db, notePath) {
  return db
    .prepare("SELECT src, kind FROM edges WHERE dst = ?")
    .all(notePath)
    .map((r) => ({ path: r.src, kind: r.kind }));
}
