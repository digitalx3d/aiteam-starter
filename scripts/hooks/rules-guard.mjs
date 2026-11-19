#!/usr/bin/env node
/*
 * rules-guard.mjs — PreToolUse enforcement for the team rules that CAN be code.
 *
 * Wired into every dispatched worker and every dashboard chat persona.
 *
 * The standard: anything in the rules files that can be coded should be
 * coded, so that the agents can't ignore or miss them. A rule written only in a
 * .md file is a suggestion that competes for attention with everything else in
 * the context. A rule in a hook fires on every single tool call, at the end of
 * the context, where it cannot be paraphrased away.
 *
 * Three rules live here. Each one exists because it was violated in practice:
 *
 * 1. RESERVED PORTS. The dashboard's port (appPort in ~/.aiteam/settings.json,
 *    3900 by default) belongs to the dashboard. Binding it from anything else
 *    takes the dashboard down and cuts the owner off from the team. The usual
 *    cause is a dev script or a client helper reaching for process.env.PORT and
 *    silently landing on the dashboard's port. As a written rule it still got
 *    broken; as a hook it can't be.
 *
 * 2. AGENT LOCATION. Personas live at the user level
 *    (~/.claude/agents/<name>.md, or agentsDir in settings.json). Writing one inside a project repo produces a
 *    second, divergent copy of a teammate that nothing loads, and the symptom
 *    (the team page shows fewer agents than expected) never points at the cause.
 *
 * 3. NO EM DASHES. The team's hard voice rule (vault/team/operating-rules.md),
 *    everywhere, including file content.
 *    It also has a mechanical justification: em dashes get mojibake'd by the
 *    build pipeline, so they corrupt on the way to disk.
 *
 * Deny contract matches the other hooks: exit 0 with
 * {hookSpecificOutput:{permissionDecision:"deny", ...}}. Reasons teach the fix.
 * Fail-open on anything unexpected: a broken guard must never brick a worker.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ~/.aiteam/settings.json, or {} if missing or unreadable. */
function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".aiteam", "settings.json"), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}
const SETTINGS = readSettings();
const APP_PORT = Number(SETTINGS.appPort) > 0 ? Number(SETTINGS.appPort) : 3900;
const RESERVED_PORTS = [APP_PORT];
const USER_CLAUDE_DIR = path.join(os.homedir(), ".claude");
const AGENTS_DIR =
  typeof SETTINGS.agentsDir === "string" && SETTINGS.agentsDir.trim()
    ? SETTINGS.agentsDir.trim()
    : path.join(USER_CLAUDE_DIR, "agents");

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  allow();
}
if (!input || typeof input !== "object") allow();

const tool = input.tool_name;
const ti = input.tool_input || {};

/** Text this tool call would write to disk, or "" for non-writing tools. */
function writtenText() {
  if (tool === "Write") return String(ti.content ?? "");
  if (tool === "Edit") return String(ti.new_string ?? "");
  if (tool === "MultiEdit" && Array.isArray(ti.edits)) {
    return ti.edits.map((e) => String(e?.new_string ?? "")).join("\n");
  }
  return "";
}

function targetPath() {
  const p = ti.file_path || ti.notebook_path || ti.path || "";
  if (!p) return "";
  const s = String(p);
  return path.isAbsolute(s) || !input.cwd ? s : path.join(input.cwd, s);
}

// Lowercase, forward slashes, and the git-bash drive form (/c/x) folded to c:/x.
const norm = (p) =>
  String(p)
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/^\/([a-z])\//, "$1:/");

// ---------------------------------------------------------------- 1. ports
// Shell commands that bind a reserved port, and package.json scripts that would.
const cmd = tool === "Bash" || tool === "PowerShell" ? String(ti.command ?? "") : "";
if (cmd) {
  for (const port of RESERVED_PORTS) {
    // --port 3900 / --port=3900 / -p 3900 / PORT=3900 / :3900 in a bind context
    const bindish = new RegExp(
      `(--port[= ]|-p[= ]|\\bPORT=|--hostname[^\\n]*:|listen\\(\\s*)${port}\\b`,
      "i"
    );
    if (bindish.test(cmd)) {
      deny(
        `Port ${port} is the aiTeam dashboard. Binding it from anything else takes ` +
          `the dashboard down and cuts the owner off from the team.\n\nUse a different port. Dev servers in the 5170-5180 range ` +
          `and API servers in 3000-3010 (avoiding ${port}) are known-safe. Hardcode it ` +
          `explicitly rather than reading process.env.PORT, which is what caused every ` +
          `previous incident.`
      );
    }
  }
}

// A dev/start script with no explicit port is how the default silently wins.
const wrote = writtenText();
if (wrote && /"(dev|start)"\s*:/.test(wrote)) {
  const scriptLines = wrote.match(/"(dev|start)"\s*:\s*"([^"]*)"/g) || [];
  for (const line of scriptLines) {
    const body = line.split(/:\s*"/)[1] || "";
    const framework = /\b(next|vite|nuxt|astro|remix)\b/.test(body);
    const hasPort = /--port[= ]|-p[= ]/.test(body);
    if (framework && !hasPort) {
      deny(
        `This dev/start script has no explicit --port, so it takes the framework ` +
          `default. That is exactly how the dashboard's port gets taken over.\n\nPin the port in the script itself, e.g. "next dev --port 3910" ` +
          `or "vite --port 5173". Never rely on the default and never read ` +
          `process.env.PORT here.`
      );
    }
  }
}

// ---------------------------------------------- 2. personas belong at user level
const target = targetPath();
if (target && (tool === "Write" || tool === "Edit" || tool === "MultiEdit")) {
  const n = norm(target);
  // Anywhere outside the user-level folders counts as "inside a repo" here.
  const under = (root) => n.startsWith(norm(root).replace(/\/$/, "") + "/");
  const insideRepo = !under(AGENTS_DIR) && !under(USER_CLAUDE_DIR);
  const personaShaped =
    /\/\.claude\/agents\//.test(n) || /\/agents\/[^/]+\/(soul|heartbeat|tools)\.md$/.test(n);
  // <project>/.aiteam/agents/<name>.md is the SUPPORTED per-project override.
  const isSupportedOverride = /\/\.aiteam\/agents\//.test(n);
  if (insideRepo && personaShaped && !isSupportedOverride) {
    deny(
      `Personas live at the user level, never inside a repo. This path would create a ` +
        `second copy of a teammate that nothing loads, and the symptom (an agent missing ` +
        `from the team page) never points back here.\n\nThe canonical home is ` +
        `${path.join(AGENTS_DIR, "<name>.md")}. If you need project-specific ` +
        `behaviour, write it to <project>\\.aiteam\\agents\\<name>.md instead, which ` +
        `layers on top of the global persona.`
    );
  }
}

// ---------------------------------------------------------------- 3. em dashes
if (wrote.includes("\u2014")) {
  const idx = wrote.indexOf("\u2014");
  const snippet = wrote.slice(Math.max(0, idx - 45), idx + 45).replace(/\s+/g, " ");
  deny(
    `Em dash found in what you are about to write. It is a hard team rule ` +
      `everywhere, file content included, and it has a mechanical reason too: em ` +
      `dashes get mojibake'd by the build pipeline, so they corrupt on the way to ` +
      `disk.\n\nHere: "...${snippet}..."\n\nUse a period, a semicolon, parentheses, ` +
      `or rephrase. A plain hyphen is fine when you actually need a dash.`
  );
}

allow();
