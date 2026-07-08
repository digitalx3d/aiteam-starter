#!/usr/bin/env node
// vault-query -- the team's structured window into its own memory.
// Reads vault/.index/index.db (built by vault-indexer.mjs). Read-only.
//
//   node scripts/vault-query.mjs status
//   node scripts/vault-query.mjs decisions --project my-app --severity high
//   node scripts/vault-query.mjs recent --days 30 --type decision
//   node scripts/vault-query.mjs orphans
//   node scripts/vault-query.mjs sessions --project my-app --days 14
//   node scripts/vault-query.mjs project my-app
//   node scripts/vault-query.mjs neighbors decisions/2026-03-08-my-app-pricing-model
//   node scripts/vault-query.mjs hops projects/my-app 2
//   node scripts/vault-query.mjs backlinks projects/other-app
//   node scripts/vault-query.mjs search "warm pool"
//   node scripts/vault-query.mjs sql "SELECT type, COUNT(*) c FROM notes GROUP BY type"
//
// Add --json to any command for machine-readable output.

import { getConfig } from "./vault-index/config.mjs";
import { openDb, getMeta } from "./vault-index/db.mjs";
import { resolveNoteRef, neighbors, nHop, backlinks } from "./vault-index/graph.mjs";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const trunc = (s, n) => {
  s = s == null ? "" : String(s).replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "~" : s;
};

function printRows(rows, columns, json) {
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log("(no rows)");
    return;
  }
  const widths = columns.map(([key, w]) => w);
  const header = columns.map(([key], i) => trunc(key, widths[i]).padEnd(widths[i])).join("  ");
  console.log(header);
  console.log(columns.map(([, w]) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    console.log(
      columns.map(([key, w]) => trunc(r[key], w).padEnd(w)).join("  ")
    );
  }
  console.log(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

const sinceIso = (days) => new Date(Date.now() - Number(days) * 864e5).toISOString();

function requireRef(db, ref, cmd) {
  if (!ref) {
    console.error(`usage: vault-query.mjs ${cmd} <note-path-or-title>`);
    process.exit(1);
  }
  const resolved = resolveNoteRef(db, ref);
  if (!resolved) {
    console.error(`Could not resolve "${ref}" to a unique note. Try the full vault-relative path.`);
    process.exit(1);
  }
  return resolved;
}

function main() {
  const cfg = getConfig();
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] || "help";
  const json = Boolean(flags.json);

  if (cmd === "help" || flags.help) {
    console.log(`vault-query -- structured queries over the team memory index
commands:
  status                              index health: counts, freshness, orphans
  decisions [--project P] [--severity S] [--status S] [--days N]
  recent    [--days 60] [--type T] [--project P] [--limit 50]
  orphans                             vault notes with no links in or out
  sessions  [--project P] [--days N] [--limit 25]    Claude Code session logs
  project <slug>                      full picture of one project
  neighbors <note>                    everything directly linked to a note
  hops <note> <n> [--through-tags]    n-hop neighborhood
  backlinks <note>                    which notes point at this one
  search <text> [--limit 30]          title/topic/tag/path substring search
  sql "SELECT ..."                    raw read-only SQL against notes/edges
add --json for machine-readable output`);
    return;
  }

  const db = openDb(cfg.dbPath, { readonly: cmd !== "__never__" });

  if (cmd === "status") {
    const bySource = db.prepare("SELECT source, COUNT(*) n FROM notes GROUP BY source ORDER BY n DESC").all();
    const byType = db.prepare("SELECT type, COUNT(*) n FROM notes GROUP BY type ORDER BY n DESC").all();
    const byKind = db.prepare("SELECT kind, COUNT(*) n, SUM(1 - resolved) unresolved FROM edges GROUP BY kind ORDER BY n DESC").all();
    const orphanCount = db.prepare(
      `SELECT COUNT(*) n FROM notes n1 WHERE source='vault'
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = n1.path)
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst = n1.path)`
    ).get().n;
    const info = {
      db: cfg.dbPath,
      last_rebuild: getMeta(db, "last_rebuild"),
      last_sweep: getMeta(db, "last_sweep"),
      notes_by_source: bySource,
      notes_by_type: byType,
      edges_by_kind: byKind,
      vault_orphans: orphanCount,
    };
    if (json) console.log(JSON.stringify(info, null, 2));
    else {
      console.log(`db:           ${info.db}`);
      console.log(`last rebuild: ${info.last_rebuild}`);
      console.log(`last sweep:   ${info.last_sweep}`);
      console.log(`notes:        ${bySource.map((r) => `${r.source}=${r.n}`).join("  ")}`);
      console.log(`types:        ${byType.map((r) => `${r.type}=${r.n}`).join("  ")}`);
      console.log(`edges:        ${byKind.map((r) => `${r.kind}=${r.n}${r.unresolved ? ` (${r.unresolved} unresolved)` : ""}`).join("  ")}`);
      console.log(`orphans:      ${orphanCount} vault notes with no edges`);
    }
  } else if (cmd === "decisions") {
    const where = ["type = 'decision'"];
    const params = [];
    if (flags.project) { where.push("project = ?"); params.push(flags.project); }
    if (flags.severity) { where.push("severity = ?"); params.push(flags.severity); }
    if (flags.status) { where.push("status = ?"); params.push(flags.status); }
    if (flags.days) { where.push("updated >= ?"); params.push(sinceIso(flags.days)); }
    const rows = db.prepare(
      `SELECT path, title, project, topic, status, severity, updated
       FROM notes WHERE ${where.join(" AND ")} ORDER BY updated DESC LIMIT ?`
    ).all(...params, Number(flags.limit || 100));
    printRows(rows, [["path", 52], ["title", 34], ["project", 12], ["status", 10], ["severity", 8], ["updated", 20]], json);
  } else if (cmd === "recent") {
    const where = ["updated >= ?"];
    const params = [sinceIso(flags.days || 60)];
    if (flags.type) { where.push("type = ?"); params.push(flags.type); }
    if (flags.project) { where.push("project = ?"); params.push(flags.project); }
    const rows = db.prepare(
      `SELECT path, title, type, project, updated FROM notes
       WHERE ${where.join(" AND ")} ORDER BY updated DESC LIMIT ?`
    ).all(...params, Number(flags.limit || 50));
    printRows(rows, [["path", 56], ["title", 36], ["type", 12], ["project", 14], ["updated", 20]], json);
  } else if (cmd === "orphans") {
    const rows = db.prepare(
      `SELECT path, title, type, updated FROM notes n1 WHERE source='vault'
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = n1.path)
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst = n1.path)
       ORDER BY updated DESC`
    ).all();
    printRows(rows, [["path", 60], ["title", 40], ["type", 14], ["updated", 20]], json);
  } else if (cmd === "sessions") {
    const where = ["source = 'session'"];
    const params = [];
    if (flags.project) { where.push("project = ?"); params.push(flags.project); }
    if (flags.days) { where.push("updated >= ?"); params.push(sinceIso(flags.days)); }
    const rows = db.prepare(
      `SELECT session_id, title, project, created, updated, body_len FROM notes
       WHERE ${where.join(" AND ")} ORDER BY updated DESC LIMIT ?`
    ).all(...params, Number(flags.limit || 25));
    printRows(rows, [["session_id", 36], ["title", 44], ["project", 16], ["updated", 20], ["body_len", 9]], json);
  } else if (cmd === "project") {
    const slug = positional[1];
    if (!slug) {
      console.error("usage: vault-query.mjs project <slug>");
      process.exit(1);
    }
    const note = db.prepare("SELECT * FROM notes WHERE path = ?").get(`projects/${slug}.md`);
    const decisions = db.prepare(
      "SELECT path, title, status, severity, updated FROM notes WHERE type='decision' AND project = ? ORDER BY updated DESC"
    ).all(slug);
    const linked = db.prepare(
      `SELECT n.path, n.title, n.type, n.updated FROM edges e JOIN notes n ON n.path = e.src
       WHERE e.dst = ? AND n.type NOT IN ('decision','session') ORDER BY n.updated DESC LIMIT 25`
    ).all(`projects/${slug}.md`);
    const sessions = db.prepare(
      "SELECT session_id, title, updated FROM notes WHERE source='session' AND project = ? ORDER BY updated DESC LIMIT 8"
    ).all(slug);
    const tasks = db.prepare(
      "SELECT path, title, status, updated FROM notes WHERE type='task' AND project = ? ORDER BY updated DESC"
    ).all(slug);
    if (json) {
      console.log(JSON.stringify({ note, decisions, linked, sessions, tasks }, null, 2));
    } else {
      console.log(note ? `# ${note.title} (${note.path}, status: ${note.status ?? "?"})` : `# ${slug} (no vault project note)`);
      console.log(`\n## Decisions (${decisions.length})`);
      printRows(decisions, [["path", 52], ["title", 34], ["status", 10], ["severity", 8], ["updated", 20]], false);
      console.log(`\n## Linked notes (${linked.length})`);
      printRows(linked, [["path", 56], ["title", 36], ["type", 14], ["updated", 20]], false);
      console.log(`\n## Recent sessions (${sessions.length})`);
      printRows(sessions, [["session_id", 36], ["title", 48], ["updated", 20]], false);
      console.log(`\n## Tasks (${tasks.length})`);
      printRows(tasks, [["path", 56], ["title", 40], ["status", 10], ["updated", 20]], false);
    }
  } else if (cmd === "neighbors") {
    const ref = requireRef(db, positional[1], "neighbors");
    const rows = neighbors(db, ref).map((r) => ({ ...r, resolved: r.resolved ? "yes" : "NO" }));
    if (!json) console.log(`neighbors of ${ref}:`);
    printRows(rows, [["other", 62], ["direction", 9], ["kind", 8], ["resolved", 8]], json);
  } else if (cmd === "hops") {
    const ref = requireRef(db, positional[1], "hops <note> <n>");
    const n = Number(positional[2] || 2);
    const rows = nHop(db, ref, n, { throughTags: Boolean(flags["through-tags"]) });
    if (!json) console.log(`within ${n} hop(s) of ${ref}:`);
    printRows(rows, [["path", 62], ["depth", 5], ["via", 44], ["kind", 8]], json);
  } else if (cmd === "backlinks") {
    const ref = requireRef(db, positional[1], "backlinks");
    const rows = backlinks(db, ref);
    if (!json) console.log(`backlinks to ${ref}:`);
    printRows(rows, [["path", 66], ["kind", 8]], json);
  } else if (cmd === "search") {
    const term = positional.slice(1).join(" ");
    if (!term) {
      console.error("usage: vault-query.mjs search <text>");
      process.exit(1);
    }
    const like = `%${term}%`;
    const rows = db.prepare(
      `SELECT path, title, type, project, updated FROM notes
       WHERE title LIKE ? OR topic LIKE ? OR path LIKE ? OR tags LIKE ? OR project LIKE ?
       ORDER BY updated DESC LIMIT ?`
    ).all(like, like, like, like, like, Number(flags.limit || 30));
    printRows(rows, [["path", 56], ["title", 38], ["type", 12], ["project", 14], ["updated", 20]], json);
  } else if (cmd === "sql") {
    const query = positional.slice(1).join(" ");
    if (!/^\s*(select|with)\b/i.test(query)) {
      console.error("Only SELECT/WITH queries are allowed (the index is read-only; markdown is the source of truth).");
      process.exit(1);
    }
    const rows = db.prepare(query).all();
    if (json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log("(no rows)");
    else {
      const cols = Object.keys(rows[0]).map((k) => [k, Math.min(60, Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)))]);
      printRows(rows, cols, false);
    }
  } else {
    console.error(`unknown command "${cmd}" -- run: node scripts/vault-query.mjs help`);
    process.exit(1);
  }
  db.close();
}

main();
