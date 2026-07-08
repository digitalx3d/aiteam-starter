#!/usr/bin/env node
// vault-indexer -- builds and maintains the SQLite index over the team's
// knowledge: vault notes, project-repo docs, and Claude Code session logs.
//
//   node scripts/vault-indexer.mjs rebuild            wipe + rebuild from disk
//   node scripts/vault-indexer.mjs watch              live watcher (pm2: vault-indexer)
//   node scripts/vault-indexer.mjs sweep              one-shot sessions/repo refresh
//   node scripts/vault-indexer.mjs autolink --all     backfill auto-links (add --dry to preview)
//   node scripts/vault-indexer.mjs autolink <file>    auto-link one vault note
//
// Markdown stays the source of truth: the DB at vault/.index/index.db is a
// derived index, safe to delete and rebuild at any time.

import path from "node:path";
import fs from "node:fs";
import { getConfig } from "./vault-index/config.mjs";
import { openDb, deleteNote, getMeta } from "./vault-index/db.mjs";
import {
  rebuild,
  sweep,
  ingestVaultFile,
  listVaultFilePaths,
} from "./vault-index/scan.mjs";
import { autolinkFile, autolinkAll } from "./vault-index/autolink.mjs";
import { autoCommitSweep } from "./vault-index/autocommit.mjs";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // sessions + repo docs
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000; // full vault stat-scan safety net
const DEBOUNCE_MS = 700;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

function vaultRel(cfg, absPath) {
  return path.relative(cfg.vaultDir, absPath).split(path.sep).join("/");
}

function isIndexablePath(rel) {
  if (!/\.md$/i.test(rel)) return false;
  const first = rel.split("/")[0];
  return ![".index", ".obsidian", ".git", "node_modules"].includes(first);
}

async function handleVaultChange(cfg, db, absPath) {
  const rel = vaultRel(cfg, absPath);
  if (!isIndexablePath(rel)) return;
  if (!fs.existsSync(absPath)) {
    deleteNote(db, rel);
    log(`removed ${rel}`);
    return;
  }
  const notePath = await ingestVaultFile(cfg, db, absPath);
  if (!notePath) return;
  const res = await autolinkFile(cfg, db, absPath);
  if (res.status === "updated" || res.status === "removed") {
    // The write above fires another watch event; the next pass re-ingests the
    // new block's links into edges and autolink then reports "unchanged",
    // which terminates the loop.
    log(`indexed ${rel} (autolink ${res.status})`);
  } else {
    log(`indexed ${rel}`);
  }
}

/** Stat-scan the vault against the DB; re-ingest changed, drop missing. */
async function reconcileVault(cfg, db) {
  const known = new Map(
    db
      .prepare("SELECT path, abs_path, mtime_ms FROM notes WHERE source = 'vault'")
      .all()
      .map((r) => [r.path, r])
  );
  let changed = 0;
  const seen = new Set();
  for (const abs of await listVaultFilePaths(cfg)) {
    const rel = vaultRel(cfg, abs);
    seen.add(rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    const prev = known.get(rel);
    if (prev && prev.mtime_ms === Math.round(stat.mtimeMs)) continue;
    await ingestVaultFile(cfg, db, abs);
    // Same treatment as a live watch event: changed notes get auto-linked
    // (the follow-up write lands as a normal watch event and converges).
    await autolinkFile(cfg, db, abs).catch(() => {});
    changed++;
  }
  let removed = 0;
  for (const rel of known.keys()) {
    if (!seen.has(rel)) {
      deleteNote(db, rel);
      removed++;
    }
  }
  if (changed || removed) log(`reconcile: ${changed} updated, ${removed} removed`);
  return { changed, removed };
}

async function watch(cfg, db) {
  log(`vault-indexer watching ${cfg.vaultDir}`);
  log(`db: ${cfg.dbPath}`);

  if (!getMeta(db, "last_rebuild")) {
    log("no previous rebuild found; running initial rebuild ...");
    const res = await rebuild(cfg, db, { log });
    log(`rebuilt: ${res.vaultNotes} vault notes, ${res.sessions} sessions, ${res.repoDocs} repo docs`);
  } else {
    await reconcileVault(cfg, db); // catch up on changes since last run
    await sweep(cfg, db, { log });
  }

  const timers = new Map();
  let watcher = null;
  try {
    watcher = fs.watch(cfg.vaultDir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const abs = path.join(cfg.vaultDir, filename.toString());
      clearTimeout(timers.get(abs));
      timers.set(
        abs,
        setTimeout(() => {
          timers.delete(abs);
          handleVaultChange(cfg, db, abs).catch((err) =>
            console.error(`[watch] ${abs}: ${err.message}`)
          );
        }, DEBOUNCE_MS)
      );
    });
    watcher.on("error", (err) => console.error(`[watch] watcher error: ${err.message}`));
  } catch (err) {
    console.error(
      `[watch] fs.watch unavailable (${err.message}); falling back to 2-minute polling`
    );
    setInterval(() => {
      reconcileVault(cfg, db).catch((e) => console.error(`[poll] ${e.message}`));
    }, 2 * 60 * 1000);
  }

  setInterval(() => {
    sweep(cfg, db, { log }).catch((e) => console.error(`[sweep] ${e.message}`));
    // Safety net behind the End Session button: commit idle/heavy chat
    // sessions through the app's real end-session route.
    autoCommitSweep(cfg, { log }).catch((e) =>
      console.error(`[autocommit] ${e.message}`)
    );
  }, SWEEP_INTERVAL_MS);
  setInterval(() => {
    reconcileVault(cfg, db).catch((e) => console.error(`[reconcile] ${e.message}`));
  }, RECONCILE_INTERVAL_MS);

  const shutdown = () => {
    log("shutting down");
    try {
      watcher?.close();
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const cfg = getConfig();
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";

  if (cmd === "rebuild" || cmd === "rebuild-index") {
    const db = openDb(cfg.dbPath);
    const t0 = Date.now();
    const res = await rebuild(cfg, db, { log });
    log(
      `rebuild complete in ${((Date.now() - t0) / 1000).toFixed(1)}s: ` +
        `${res.vaultNotes} vault notes, ${res.sessions} sessions, ${res.repoDocs} repo docs`
    );
    const unmapped = Object.keys(res.repoMap.slugToDir).length;
    log(`repo map (${unmapped} project slugs mapped): ${JSON.stringify(res.repoMap.slugToDir)}`);
    db.close();
  } else if (cmd === "watch") {
    const db = openDb(cfg.dbPath);
    await watch(cfg, db);
    // keeps running; shutdown via signals
  } else if (cmd === "sweep") {
    const db = openDb(cfg.dbPath);
    const res = await sweep(cfg, db, { log });
    log(`sweep complete: ${res.changed} updated, ${res.removed} removed`);
    db.close();
  } else if (cmd === "autocommit") {
    const dryRun = args.includes("--dry");
    const res = await autoCommitSweep(cfg, { dryRun, log });
    for (const v of res.verdicts) {
      log(`  ${v.fire ? "FIRE " : "skip "} ${v.scope}: ${v.reason}`);
    }
    log(`autocommit ${dryRun ? "(dry) " : ""}done: ${res.fired}/${res.scopes} scopes ${dryRun ? "would commit" : "committed"}`);
  } else if (cmd === "autolink") {
    const dryRun = args.includes("--dry");
    const db = openDb(cfg.dbPath);
    if (args.includes("--all")) {
      const res = await autolinkAll(cfg, db, { dryRun, log: (m) => log(m) });
      log(
        `autolink ${dryRun ? "(dry run) " : ""}complete: ` +
          `${res.updated.length} updated, ${res.removed.length} removed, ` +
          `${res.unchanged} unchanged, ${res.skipped} skipped`
      );
    } else {
      const target = args.find((a) => a !== "autolink" && !a.startsWith("--"));
      if (!target) {
        console.error("usage: vault-indexer.mjs autolink (--all | <file>) [--dry]");
        process.exit(1);
      }
      const abs = path.isAbsolute(target) ? target : path.join(cfg.vaultDir, target);
      const res = await autolinkFile(cfg, db, abs, { dryRun });
      log(`autolink ${vaultRel(cfg, abs)}: ${res.status}${res.reason ? ` (${res.reason})` : ""}`);
      if (res.block) console.log(res.block);
    }
    db.close();
  } else {
    console.log(`vault-indexer -- SQLite index over vault + repos + session logs
usage:
  node scripts/vault-indexer.mjs rebuild             wipe and rebuild the whole index
  node scripts/vault-indexer.mjs watch               run the live watcher (pm2 service)
  node scripts/vault-indexer.mjs sweep               refresh sessions + repo docs once
  node scripts/vault-indexer.mjs autolink --all      auto-link every eligible vault note
  node scripts/vault-indexer.mjs autolink <file>     auto-link one note
  add --dry to autolink to preview without writing`);
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
