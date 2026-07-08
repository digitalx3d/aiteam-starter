#!/usr/bin/env node
// inbox-for.mjs — read shared inbox entries addressed to a specific agent.
//
// Cross-platform Node port of inbox-for.ps1 (same state file, same semantics),
// so personas work on Windows, macOS, and Linux without PowerShell.
//
// Returns the inbox-shared.md entries addressed to <agent> that have an id
// greater than the agent's last_read_id. Optionally updates the read state.
//
// Usage:
//   node scripts/inbox-for.mjs --agent indy              # print unread, do NOT mark
//   node scripts/inbox-for.mjs --agent indy --mark-read  # print AND mark as read
//   node scripts/inbox-for.mjs --agent indy --inbox <path-to-inbox-shared.md>
//
// Address semantics:
//   - An entry is addressed to <agent> if its `to:` field contains the agent's
//     lowercase name OR the literal token "all" (broadcast).
//   - Entries with no `to:` field are skipped (treated as informational only).
//
// Id format: YYYY-MM-DDTHHMM-<from>-<slug>. Lexicographic comparison works.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const flags = parseArgs(process.argv.slice(2));
const agent = String(flags.agent || "").toLowerCase();
if (!agent) {
  console.error("error: --agent <name> is required");
  process.exit(2);
}

// Default inbox: inbox-shared.md at the repo root (this script lives in <repo>/scripts/).
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const inboxPath = flags.inbox
  ? String(flags.inbox)
  : path.join(path.dirname(scriptDir), "inbox-shared.md");

// Personas folder: ~/.aiteam/settings.json agentsDir if set, else ~/.claude/agents.
let agentsRoot = path.join(os.homedir(), ".claude", "agents");
try {
  const s = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".aiteam", "settings.json"), "utf8")
  );
  if (s.agentsDir) agentsRoot = String(s.agentsDir);
} catch {
  /* default */
}

// CVB's persona folder is `claude/` not `cvb/` (historical). Map for state lookup.
const folderName = agent === "cvb" ? "claude" : agent;
const stateDir = path.join(agentsRoot, folderName);
const statePath = path.join(stateDir, "inbox-state.json");

let lastReadId = "0000-00-00T0000-init";
try {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state.last_read_id) lastReadId = String(state.last_read_id);
} catch {
  /* first read */
}

let content;
try {
  content = fs.readFileSync(inboxPath, "utf8");
} catch {
  console.log(`(inbox-shared.md not found at ${inboxPath})`);
  process.exit(0);
}

// Entries are separated by lines containing only "---"; first part is the header.
const parts = content.split(/^---\s*$/m);
const entries = parts.slice(1).filter((p) => p.trim().length > 0);

const unread = [];
let newestId = lastReadId;

for (const entry of entries) {
  const idMatch = /\*\*id:\*\*\s*([^\s*\n]+)/.exec(entry);
  const toMatch = /\*\*to:\*\*\s*([^*\n]+?)(?=\s*[*\n]|$)/.exec(entry);

  if (!idMatch) continue; // skip un-tagged entries (pre-convention)
  const id = idMatch[1].trim();
  const to = toMatch ? toMatch[1].trim() : "";

  const toTokens = to
    .split(/[,\s·]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!toTokens.includes(agent) && !toTokens.includes("all")) continue;

  if (id <= lastReadId) continue;

  unread.push({ id, content: entry.replace(/^\s+/, "") });
  if (id > newestId) newestId = id;
}

if (unread.length === 0) {
  console.log(`(no new entries for ${agent} since ${lastReadId})`);
  process.exit(0);
}

for (const u of unread) {
  console.log("---");
  console.log(u.content.replace(/\s+$/, ""));
  console.log("");
}

if (flags["mark-read"]) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({ last_read_id: newestId }, null, 2) + "\n",
    "utf8"
  );
  console.log(`[MARKED-READ: ${unread.length} entries; last_read_id = ${newestId}]`);
}
