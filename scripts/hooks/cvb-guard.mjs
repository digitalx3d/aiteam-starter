#!/usr/bin/env node
/*
 * cvb-guard.mjs: PreToolUse bouncer for Claude Von Braun (CVB), the orchestrator.
 *
 * Wired ONLY into CVB's dashboard chat sessions (via --settings, generated per spawn
 * by the app). Runs as CODE before every Edit/Write/MultiEdit/NotebookEdit/Bash, so
 * it cannot be rationalized away or eroded mid-session the way a persona rule can.
 *
 * Policy (data lives in cvb-guard.config.json):
 *   - CVB may WRITE coordination artifacts (task boards under .aiteam/, inbox-shared.md,
 *     teammates' inbox.md, his own status/memory, vault notes, temp scratch). Allowed.
 *   - THE NOTES RULE: he may also write NOTE-SHAPED files (.md, .txt, .csv, .json,
 *     .log, .yml ...) anywhere under the projects folder and his own .claude folder -
 *     plans, analyses, task files, captured output. The line is drawn by FILE TYPE, not by
 *     folder, because that is what actually separates "a note" from "the work". Three
 *     carve-outs keep it honest: content/blog trees (markdown there is Casey's article),
 *     src/ and build dirs, and project config files that happen to be .json/.yml.
 *   - CVB may NOT write DELIVERABLES (project code, copy, images). Denied, told to dispatch.
 *     Any extension outside noteExtensions is a deliverable by definition, so no code
 *     extension has to be enumerated to stay blocked.
 *   - CVB may NOT write GOVERNANCE files (personas: soul/agents/tools/heartbeat/projects;
 *     vault/team canon) even where an allow rule would match — denied, told to ask the owner.
 *   - Bash is default-allow. STANDING RELEASE AUTHORIZATION (the owner's
 *     standing grant to CVB): ordinary git writes (add/commit/merge/checkout/plain
 *     push), builds, pm2, and deploy scripts are ALLOWED — CVB ships reviewed work himself.
 *     Still DENIED: history surgery (git rebase|reset|clean|cherry-pick|am|apply), force or
 *     delete pushes, commit --amend, package publishing, image-gen python, and raw file
 *     mutation (rm/mv/cp). Shell REDIRECTS (>, >>) are checked by their TARGET path with the
 *     SAME allow-list as the Write tool, so `cat > .aiteam/briefs/x.md` (coordination) is
 *     fine but `> src/index.js` is not.
 *
 * Deny contract: exit 0 with {hookSpecificOutput:{permissionDecision:"deny",...}}. The
 * reason is shown to CVB, so a block teaches ("dispatch to Devin") instead of just failing.
 * Fail-open: unparseable input or missing config => allow, so a broken guard never bricks CVB.
 *
 * Part of the agent-governance-lockdown project. See docs/agent-governance-lockdown-plan.md.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNERS = "Devin=code/frontend, Casey=copy, Maya=images";
// Always teach the ABSOLUTE courier path: CVB's cwd varies by chat (app folder in
// The Bridge, the project folder in project chats), so a relative path fails there.
// Derived from this hook's own location, dispatch.mjs is its sibling's parent.
const DISPATCH_PATH = path.resolve(HERE, "..", "dispatch.mjs").replace(/\\/g, "/");
const DISPATCH = `node ${DISPATCH_PATH} --agent <owner> --project <slug> --brief "<what + what good looks like>"`;

// The human owner's first name, from ~/.aiteam/settings.json (same source as
// the app's Settings page). Fallback keeps the guard working unconfigured.
function ownerFirst() {
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".aiteam", "settings.json"), "utf8")
    );
    const full = String(s.ownerName || "").trim();
    if (full) return full.split(/\s+/)[0];
  } catch {
    /* fall through */
  }
  return (process.env.AITEAM_OWNER_NAME || "").trim().split(/\s+/)[0] || "the boss";
}
const OWNER = ownerFirst();

function allow() {
  // No output + exit 0 = defer to the normal permission flow (acceptEdits auto-approves
  // allowed writes; Bash is already in CVB's allowedTools).
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

function logEvent(entry) {
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), "cvb-guard.log.jsonl"),
      JSON.stringify(entry) + "\n"
    );
  } catch {
    /* logging is best-effort; never let it affect the decision */
  }
}

function norm(p) {
  return String(p).replace(/\\/g, "/").toLowerCase();
}

// Does this redirect operand look like a filename at all? Used to tell a genuine
// `> out.log` from a ">" that was really a comparison operator inside inline code.
// Requires path-safe characters throughout, plus either a separator or an extension.
function looksLikePath(t) {
  const s = String(t).trim();
  if (!s || s.length > 400) return false;
  if (!/^[A-Za-z0-9_.~@+\-/\\:]+$/.test(s)) return false; // no ( ) { } [ ] = , ' " ` etc.
  return /[/\\]/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

// --- read hook input (stdin JSON) ---
let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  allow(); // fail-open
}
if (!input || typeof input !== "object") allow();

// --- load policy data ---
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(HERE, "cvb-guard.config.json"), "utf8"));
} catch {
  allow(); // fail-open if the config is missing/corrupt; don't brick CVB
}

/**
 * Classify a write TARGET path (used by both the Edit/Write handler and the Bash
 * redirect check, so the policy is identical however the file gets written):
 *   "governance": a persona / team-rule file; off-limits regardless of allow rules.
 *   "allowed":     a coordination artifact or a note CVB may write.
 *   "deliverable": everything else; CVB must dispatch it.
 *
 * Order matters: governance wins over every allow rule, then the explicit
 * coordination path allow-list (any file type), then the notes rule.
 */
function classifyWritePath(fp) {
  let p = fp;
  if (!path.isAbsolute(p) && input.cwd) p = path.join(input.cwd, p);
  const n = norm(p);
  const base = n.split("/").pop();

  const denyBasenames = cfg.writeDenyBasenames || [];
  const denyContains = cfg.writeDenyContains || [];
  if (denyBasenames.includes(base) || denyContains.some((c) => n.includes(c))) {
    return { cls: "governance", n };
  }

  const prefixes = cfg.writeAllowPrefixes || [];
  const contains = cfg.writeAllowContains || [];
  const exact = cfg.writeAllowExact || [];
  const regexes = (cfg.writeAllowRegex || []).map((r) => new RegExp(r, "i"));
  const allowed =
    prefixes.some((pre) => n.startsWith(pre)) ||
    contains.some((c) => n.includes(c)) ||
    exact.includes(n) ||
    regexes.some((rx) => rx.test(n));
  if (allowed) return { cls: "allowed", n };

  // --- THE NOTES RULE ---
  // A note-shaped file (.md/.txt/.json/... ) under a known root is CVB's to write:
  // plans, task files, analyses, captured output. Anything NOT wearing a note
  // extension is a deliverable by definition, which is what keeps him out of code,
  // images and binaries without needing to enumerate every code extension.
  const noteExts = cfg.noteExtensions || [];
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
  if (noteExts.includes(ext)) {
    const roots = cfg.noteAllowRoots || [];
    const inRoot = roots.some((r) => n.startsWith(r));
    const noteDenyContains = cfg.noteDenyContains || [];
    const noteDenyBasenames = cfg.noteDenyBasenames || [];
    const carvedOut =
      noteDenyContains.some((c) => n.includes(c)) || noteDenyBasenames.includes(base);
    if (inRoot && !carvedOut) return { cls: "allowed", n };
    if (inRoot && carvedOut) return { cls: "deliverable", n, why: "carve-out" };
  }

  return { cls: "deliverable", n, why: noteExts.includes(ext) ? "outside-roots" : "not-a-note" };
}

function denyGovernance(target) {
  logEvent({ t: new Date().toISOString(), tool, target, decision: "deny", why: "governance" });
  deny(
    `Blocked by the CVB guard: "${target}" is a governance file (a persona or a team-wide rule). ` +
      `Changing personas or hard rules needs ${OWNER}'s explicit go-ahead, propose the change in chat, don't edit it directly.`
  );
}

const WHY_HINT = {
  "not-a-note":
    "That file type is a deliverable (code, markup, an image, a binary). Notes are yours; source files are the owner's.",
  "carve-out":
    "It wears a note extension but sits where notes ARE the deliverable (a content/blog tree, a src/ folder) or it is a project config file.",
  "outside-roots":
    "It is note-shaped but lives outside the roots you write in (the projects folder and your own .claude folder).",
};

function denyDeliverable(target, why) {
  logEvent({ t: new Date().toISOString(), tool, target, decision: "deny", why: why || "deliverable" });
  deny(
    `Blocked by the CVB guard: "${target}" is a deliverable, not a note. ` +
      `${WHY_HINT[why] || "You orchestrate; you do not do the work yourself."} ` +
      `Dispatch it (absolute path, works from any chat): ${DISPATCH}. ` +
      `Owners: ${OWNERS}. If a direct edit is truly warranted, ask ${OWNER} to approve it in chat. ` +
      `(You CAN write, without asking: any .md/.txt/.csv/.json/.log note under the projects folder, task boards and briefs under .aiteam/, ` +
      `inbox-shared.md, teammates' inbox.md, scratch files in temp, your own status/memory, and vault notes outside team/.)`
  );
}

const tool = input.tool_name;
const ti = input.tool_input || {};

// ==== Edit/Write family: path allow/deny ====
if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const fp = ti.file_path || ti.notebook_path || ti.path || "";
  if (!fp) allow();
  const { cls, why } = classifyWritePath(fp);
  if (cls === "governance") denyGovernance(fp);
  if (cls === "allowed") allow();
  denyDeliverable(fp, why);
}

// ==== Bash: block deliverable-producing / mutating commands ====
if (tool === "Bash") {
  const raw = String(ti.command || "");
  // Strip quoted substrings first so a dispatch brief or echo text (e.g. --brief "run npm build",
  // or a quoted ">") can't trip a deny rule. Backticks go FIRST: a JS template literal
  // routinely contains quotes, and stripping quotes first would leave its backticks orphaned
  // and its contents exposed to the redirect scanner.
  const unquoted = raw
    .replace(/`[^`]*`/g, "``")
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");
  const segments = unquoted
    .split(/;|\n|&&|\|\||\||&/)
    .map((s) => s.trim())
    .filter(Boolean);

  const denyTokens = (cfg.bashDenyFirstToken || []).map((s) => s.toLowerCase());
  const denyRegexes = (cfg.bashDenyRegex || []).map((r) => new RegExp(r, "i"));

  for (const seg of segments) {
    // 1) Dangerous executable as the command (rm, mv, cp, python, ...).
    const firstToken = seg
      .split(/\s+/)[0]
      .toLowerCase()
      .replace(/^.*[\\/]/, ""); // strip any path, keep the executable name
    if (denyTokens.includes(firstToken)) {
      logEvent({ t: new Date().toISOString(), tool, cmd: raw, decision: "deny", why: `token:${firstToken}` });
      deny(
        `Blocked by the CVB guard: "${firstToken}" mutates files or produces a deliverable. ` +
          `You don't execute the work, dispatch it to the owner (${OWNERS}) via ${DISPATCH}, or ask ${OWNER}. ` +
          `Coordination and release Bash (git reads, add/commit/merge/plain push, npm builds, pm2, the dispatch courier) is fine.`
      );
    }

    // 2) Build / deploy / generate patterns.
    for (const rx of denyRegexes) {
      if (rx.test(seg)) {
        logEvent({ t: new Date().toISOString(), tool, cmd: raw, decision: "deny", why: `regex:${rx.source}` });
        deny(
          `Blocked by the CVB guard: that command is still ${OWNER}'s call. Git history surgery (rebase/reset/clean/cherry-pick), ` +
            `force or delete pushes, amended commits, package publishing, and image-generation scripts stay behind an explicit go-ahead. ` +
            `Ordinary commits, merges, plain pushes, builds, pm2, and deploys ARE yours (standing grant, 2026-07-05), ` +
            `if this command is truly needed, ask ${OWNER} in chat first.`
        );
      }
    }

    // 3) Shell redirects (> / >>) are file writes, judge them by their TARGET, same
    //    allow-list as the Write tool. Coordination targets are fine; deliverables/governance
    //    are not. (`2>&1` and other &-redirects are not file targets, so they don't match.)
    const targets = [...seg.matchAll(/>>?\s*([^\s&|;<>]+)/g)].map((m) => m[1]);
    for (const target of targets) {
      // Discard / device sinks are not files to protect (e.g. `2>/dev/null`).
      const nt = norm(target);
      if (["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero", "nul", "con"].includes(nt)) {
        continue;
      }
      // A ">" is far more often a comparison operator inside inline code than a redirect.
      // `if (g > 60)` used to be read as a write to a file called "60)gaps.push(...)", and
      // CVB got blocked mid-analysis for a write he never attempted. Only treat a target as
      // a real file if it is SHAPED like one: path-safe characters throughout, and either a
      // directory separator or a plausible extension. Everything a redirect can legitimately
      // name still qualifies; operands like `0)`, `-1){`, `codes[s]=(codes[s]` and bare words
      // like `Signing` do not.
      if (!looksLikePath(target)) continue;
      const { cls, why } = classifyWritePath(target);
      if (cls === "governance") denyGovernance(target);
      if (cls === "deliverable") {
        logEvent({ t: new Date().toISOString(), tool, cmd: raw, target, decision: "deny", why: `redirect:${why || "deliverable"}` });
        deny(
          `Blocked by the CVB guard: writing to "${target}" via a shell redirect, and that path is a deliverable, not a note. ` +
            `${WHY_HINT[why] || ""} ` +
            `Notes (.md/.txt/.csv/.json/.log) under the projects folder, anything under .aiteam/, and scratch files in temp are all fine to write. ` +
            `Dispatch deliverable work to the owner (${OWNERS}) via ${DISPATCH}.`
        );
      }
      // "allowed" → fine, keep scanning.
    }
  }
  allow();
}

// Any other tool (matcher shouldn't send these), allow.
allow();
