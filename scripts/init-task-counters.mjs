#!/usr/bin/env node
/**
 * Switch on per-project task numbering.
 *
 * Writes a `.task-counter.json` into every project's `.aiteam/tasks/` folder.
 * The counter records which task files already existed ("legacy") so they are
 * never retroactively numbered, and sets the next number to 1. From then on
 * the dashboard numbers every new task, whether it came from the New Task
 * button or from an agent writing a markdown file straight to disk.
 *
 * Safe to re-run: projects that already have a counter are left alone.
 * Pass --force to rebuild a counter (this re-freezes the current files as
 * legacy and resets the next number, so only use it on a project that has
 * never issued a number).
 *
 * Usage:
 *   node scripts/init-task-counters.mjs [--root <dir>] [--force] [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const COUNTER_FILE = ".task-counter.json";
const SETTINGS = path.join(os.homedir(), ".aiteam", "settings.json");

function parseArgs(argv) {
  const out = { root: null, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

function resolveProjectsRoot(explicit) {
  if (explicit) return explicit;
  if (process.env.PROJECTS_ROOT) return process.env.PROJECTS_ROOT;
  try {
    const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    if (cfg.projectsRoot) return cfg.projectsRoot;
  } catch {
    /* fall through */
  }
  // Default: the folder containing this repo.
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
}

function taskDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read projects root ${root}: ${err.message}`);
    process.exit(1);
  }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const tasks = path.join(root, e.name, ".aiteam", "tasks");
    if (fs.existsSync(tasks)) dirs.push({ project: e.name, dir: tasks });
  }
  return dirs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveProjectsRoot(args.root);
  const dirs = taskDirs(root);
  console.log(`Projects root: ${root}`);
  console.log(`Found ${dirs.length} project task folders.\n`);

  let created = 0;
  let skipped = 0;

  for (const { project, dir } of dirs) {
    const counterPath = path.join(dir, COUNTER_FILE);
    if (fs.existsSync(counterPath) && !args.force) {
      skipped += 1;
      console.log(`  skip   ${project} (counter exists)`);
      continue;
    }
    const legacy = fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".md"));
    const counter = {
      next: 1,
      legacy,
      initialized: new Date().toISOString(),
    };
    if (!args.dryRun) {
      fs.writeFileSync(counterPath, `${JSON.stringify(counter, null, 2)}\n`, "utf8");
    }
    created += 1;
    console.log(
      `  init   ${project} (${legacy.length} existing task${
        legacy.length === 1 ? "" : "s"
      } kept unnumbered, next is #0001)`
    );
  }

  console.log(
    `\n${args.dryRun ? "[dry run] " : ""}Initialized ${created}, skipped ${skipped}.`
  );
}

main();
