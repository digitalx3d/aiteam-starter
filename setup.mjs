#!/usr/bin/env node
/*
 * setup.mjs — first-run setup for the aiTeam starter.
 *
 * Run from the repo root:   node setup.mjs
 *
 * What it does, in order:
 *   1. Checks prerequisites (Node 20+, the Claude Code CLI on PATH).
 *   2. Asks for your name and three paths (projects root, vault, personas).
 *   3. Writes ~/.aiteam/settings.json — the app and all scripts read config there.
 *   4. Scaffolds the vault (team rules + roster the agents are governed by).
 *   5. Seeds the starter personas (CVB, Maya, Devin, Casey) into your personas
 *      folder, filling in your name and paths. Existing personas are never
 *      overwritten.
 *   6. Renders scripts/hooks/cvb-guard.config.json (the orchestrator's guardrails)
 *      for your paths.
 *   7. Creates big5.md, inbox-shared.md, and .env from their templates.
 *   8. Offers to run `npm install` in app/.
 *
 * Safe to re-run: every step skips anything that already exists.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(os.homedir(), ".aiteam", "settings.json");

// Forward slashes everywhere: Node accepts them on every OS, and the guard
// hook compares lowercase forward-slash paths.
const fwd = (p) => p.replace(/\\/g, "/");

function ok(msg) {
  console.log(`  [ok] ${msg}`);
}
function warn(msg) {
  console.log(`  [!!] ${msg}`);
}

// ---------- 1. prerequisites ----------
function checkPrereqs() {
  console.log("\nChecking prerequisites...");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    warn(`Node ${process.versions.node} found; Node 20+ is required. Install from https://nodejs.org and re-run.`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);

  const claude = spawnSync("claude", ["--version"], { shell: true, encoding: "utf8" });
  if (claude.status === 0) {
    ok(`Claude Code CLI (${String(claude.stdout).trim()})`);
  } else {
    warn("Claude Code CLI not found on PATH. The dashboard cannot chat or dispatch without it.");
    warn("Install it first: https://docs.claude.com/en/docs/claude-code  — then re-run this script.");
    process.exit(1);
  }
}

/** True if nothing is currently listening on the port. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

// ---------- 2. questions ----------
async function askQuestions(existingSettings) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || def || "";
  };

  console.log("\nA few questions (Enter accepts the default):\n");
  let ownerName = "";
  while (!ownerName) {
    ownerName = await ask('Your name, as the team should use it (e.g. "Jane Smith")');
    if (!ownerName) console.log("  Your team needs to know who the boss is.");
  }
  const projectsRoot = await ask(
    "Projects root — the folder your repos live in (the Projects page scans it)",
    path.dirname(REPO)
  );
  const vaultDir = await ask(
    "Vault folder — the team's long-term memory (transcripts, decisions, rules). Created if missing",
    path.join(path.dirname(REPO), "vault")
  );
  const agentsDir = await ask(
    "Personas folder — where agent personalities live",
    path.join(os.homedir(), ".claude", "agents")
  );

  // Dashboard port. Everything (the app, the dispatch courier, pm2, the
  // tunnel watchdog) follows this one setting, so picking a free port here
  // is all it takes when 3900 is already occupied on this machine.
  let appPort = 0;
  while (!appPort) {
    const raw = await ask(
      "Dashboard port",
      String(existingSettings.appPort || 3900)
    );
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      console.log("  Pick a whole number between 1024 and 65535.");
      continue;
    }
    if (!(await portIsFree(n))) {
      const answer = (
        await rl.question(
          `  Something is already listening on ${n}. Use it anyway (it might be your own aiTeam)? [y/N]: `
        )
      )
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") continue;
    }
    appPort = n;
  }
  rl.close();
  return { ownerName, projectsRoot, vaultDir, agentsDir, appPort };
}

// ---------- token rendering ----------
function makeTokens(a) {
  // Claude Code names each project's session/memory folder after its path,
  // with separators and colons flattened to dashes (C:\Code\aiTeam →
  // C--Code-aiTeam). CVB's auto-memory lives under that folder.
  const projectSlug = REPO.replace(/[\\/:]/g, "-");
  return {
    "{{OWNER_NAME}}": a.ownerName,
    "{{OWNER_FIRST}}": a.ownerName.split(/\s+/)[0],
    "{{AITEAM_DIR}}": fwd(REPO),
    "{{AITEAM_DIR_FWD}}": fwd(REPO),
    "{{VAULT_DIR}}": fwd(a.vaultDir),
    "{{AGENTS_DIR}}": fwd(a.agentsDir),
    "{{PROJECTS_ROOT}}": fwd(a.projectsRoot),
    "{{MEMORY_DIR}}": fwd(path.join(os.homedir(), ".claude", "projects", projectSlug, "memory")),
  };
}

function render(text, tokens) {
  let out = text;
  for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(v);
  return out;
}

const TEXT_EXT = new Set([".md", ".json", ".txt"]);

/** Copy a file or directory tree, rendering tokens in text files. Never overwrites. */
function seedPath(src, dest, tokens) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) {
      seedPath(path.join(src, e), path.join(dest, e), tokens);
    }
    return;
  }
  if (fs.existsSync(dest)) return; // never clobber
  const ext = path.extname(src).toLowerCase();
  if (TEXT_EXT.has(ext)) {
    let text = render(fs.readFileSync(src, "utf8"), tokens);
    // The persona/vault templates spell paths with Windows separators. On
    // macOS/Linux flip them so agents read native paths. Markdown only —
    // code files can contain legitimate backslash escapes.
    if (process.platform !== "win32" && ext === ".md") {
      text = text.replace(/\\/g, "/");
    }
    fs.writeFileSync(dest, text, "utf8");
  } else {
    fs.copyFileSync(src, dest);
  }
}

// ---------- main ----------
checkPrereqs();
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
} catch {
  /* fresh install */
}
const answers = await askQuestions(settings);
const tokens = makeTokens(answers);
const first = tokens["{{OWNER_FIRST}}"];

// 3. settings file (merged over anything already there)
console.log("\nWriting config...");
Object.assign(settings, {
  ownerName: answers.ownerName,
  projectsRoot: answers.projectsRoot,
  vaultDir: answers.vaultDir,
  agentsDir: answers.agentsDir,
  aiteamDir: REPO,
  appPort: String(answers.appPort),
});
fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", "utf8");
ok(`${SETTINGS_FILE} (change any of this later on the dashboard's Settings page)`);

// 3b. The app's dev/start scripts carry the port literally (npm scripts can't
// read the settings file). pm2, the dispatch courier, and the tunnel watchdog
// all resolve settings.json themselves — this rewrite is only for `npm run
// dev` / `npm run start`.
const pkgPath = path.join(REPO, "app", "package.json");
const pkgRaw = fs.readFileSync(pkgPath, "utf8");
const pkgNew = pkgRaw.replace(/--port \d+/g, `--port ${answers.appPort}`);
if (pkgNew !== pkgRaw) {
  fs.writeFileSync(pkgPath, pkgNew, "utf8");
  ok(`app/package.json dev/start scripts set to port ${answers.appPort}`);
}

// 4. vault scaffold
for (const d of ["team", "transcripts", "decisions", "agents", "projects"]) {
  fs.mkdirSync(path.join(answers.vaultDir, d), { recursive: true });
}
seedPath(path.join(REPO, "starter-vault", "team"), path.join(answers.vaultDir, "team"), tokens);
ok(`vault at ${answers.vaultDir} (team rules + roster; edit them — they govern your agents)`);

// 5. personas
const STARTERS = ["claude", "maya", "devin", "casey"];
const RUNTIME_FILES = {
  "inbox.md": `# Inbox\n\nMessages from CVB and teammates land here. Newest on top.\n`,
  "completed.md": `# Completed\n\n`,
  "now.md": `standby [aiteam] — Ready for work.\n`,
};
for (const name of STARTERS) {
  const srcDir = path.join(REPO, "starter-agents", name);
  const destDir = path.join(answers.agentsDir, name);
  const existed = fs.existsSync(destDir);
  seedPath(srcDir, destDir, tokens);
  for (const [f, content] of Object.entries(RUNTIME_FILES)) {
    const p = path.join(destDir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content, "utf8");
  }
  // The subagent definition (claude has none — the orchestrator is not a subagent).
  const defSrc = path.join(REPO, "starter-agents", `${name}.md`);
  if (fs.existsSync(defSrc)) {
    const defDest = path.join(answers.agentsDir, `${name}.md`);
    if (!fs.existsSync(defDest)) {
      fs.writeFileSync(defDest, render(fs.readFileSync(defSrc, "utf8"), tokens), "utf8");
    }
  }
  ok(`persona ${name}${existed ? " (already existed — only missing files added)" : ""}`);
}

// 5b. skills (team-authored Claude Code skills the personas reference)
const skillsSrc = path.join(REPO, "starter-skills");
if (fs.existsSync(skillsSrc)) {
  const skillsDest = path.join(os.homedir(), ".claude", "skills");
  seedPath(skillsSrc, skillsDest, tokens);
  ok(`skills seeded to ${skillsDest}`);
}

// 6. CVB guard config
const guardTemplate = path.join(REPO, "scripts", "hooks", "cvb-guard.config.template.json");
const guardOut = path.join(REPO, "scripts", "hooks", "cvb-guard.config.json");
if (!fs.existsSync(guardOut)) {
  const lowerTokens = Object.fromEntries(
    Object.entries(tokens).map(([k, v]) => [k, String(v).toLowerCase()])
  );
  fs.writeFileSync(guardOut, render(fs.readFileSync(guardTemplate, "utf8"), lowerTokens), "utf8");
  ok("cvb-guard.config.json (the orchestrator's write/command guardrails)");
} else {
  ok("cvb-guard.config.json already present — left as is");
}

// 7. personal files + .env
const copies = [
  ["big5.example.md", "big5.md"],
  ["inbox-shared.example.md", "inbox-shared.md"],
  [".env.example", ".env"],
];
for (const [from, to] of copies) {
  const src = path.join(REPO, from);
  const dest = path.join(REPO, to);
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
    ok(`${to} created from ${from}`);
  }
}

// 8. npm install
const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
const doInstall = (await rl2.question("\nRun `npm install` in app/ now? [Y/n]: ")).trim().toLowerCase();
rl2.close();
if (doInstall === "" || doInstall === "y" || doInstall === "yes") {
  const r = spawnSync("npm", ["install"], {
    cwd: path.join(REPO, "app"),
    shell: true,
    stdio: "inherit",
  });
  if (r.status !== 0) warn("npm install failed — run it yourself in app/ before starting.");
}

console.log(`
Done, ${first}. Next steps:

  1. cd app && npm run dev        then open http://localhost:${answers.appPort}
  2. Meet the team on the Team page; talk to Claude Von Braun on the Dashboard.
  3. Image generation (Maya) needs API keys — put OPENAI_API_KEY and/or
     GEMINI_API_KEY in the .env file at the repo root. Skip if you won't use her.
  4. For run-it-always production + phone access, see "Running it for real"
     in the README (pm2 + Tailscale).
`);
