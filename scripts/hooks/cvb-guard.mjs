#!/usr/bin/env node
/*
 * cvb-guard.mjs — PreToolUse bouncer for Claude Von Braun (CVB), the orchestrator.
 *
 * Wired ONLY into CVB's dashboard chat sessions (via --settings, generated per spawn
 * by the app). Runs as CODE before every Edit/Write/MultiEdit/NotebookEdit/Bash, so
 * it cannot be rationalized away or eroded mid-session the way a persona rule can.
 *
 * Policy (data lives in cvb-guard.config.json):
 *   - CVB may WRITE coordination artifacts (task boards under .aiteam/, inbox-shared.md,
 *     his own status/memory, vault notes) — allowed.
 *   - CVB may NOT write DELIVERABLES (project code, copy, images) — denied, told to dispatch.
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
const OWNERS = "Devin=code/frontend, Casey=copy, Maya=images, Indy=research, Ethan=security";
// Always teach the ABSOLUTE courier path: CVB's cwd varies by chat (app folder in
// The Bridge, the project folder in project chats), so a relative path fails there.
// Derived from this hook's own location — dispatch.mjs is its sibling's parent.
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
  allow(); // fail-open if the config is missing/corrupt — don't brick CVB
}

/**
 * Classify a write TARGET path (used by both the Edit/Write handler and the Bash
 * redirect check, so the policy is identical however the file gets written):
 *   "governance"  — a persona / team-rule file; off-limits regardless of allow rules.
 *   "allowed"     — a coordination artifact CVB may write.
 *   "deliverable" — everything else; CVB must dispatch it.
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
  return { cls: allowed ? "allowed" : "deliverable", n };
}

function denyGovernance(target) {
  logEvent({ t: new Date().toISOString(), tool, target, decision: "deny", why: "governance" });
  deny(
    `Blocked by the CVB guard: "${target}" is a governance file (a persona or a team-wide rule). ` +
      `Changing personas or hard rules needs ${OWNER}'s explicit go-ahead — propose the change in chat, don't edit it directly.`
  );
}

function denyDeliverable(target) {
  logEvent({ t: new Date().toISOString(), tool, target, decision: "deny", why: "deliverable" });
  deny(
    `Blocked by the CVB guard: "${target}" is a deliverable, not a coordination file. You orchestrate; you do not do the work yourself. ` +
      `Dispatch it (absolute path, works from any chat): ${DISPATCH}. ` +
      `Owners: ${OWNERS}. If a direct edit is truly warranted, ask ${OWNER} to approve it in chat. ` +
      `(You CAN write: task boards / briefs under .aiteam/, inbox-shared.md, your own status/memory, and vault notes outside team/.)`
  );
}

const tool = input.tool_name;
const ti = input.tool_input || {};

// ==== Edit/Write family: path allow/deny ====
if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const fp = ti.file_path || ti.notebook_path || ti.path || "";
  if (!fp) allow();
  const { cls } = classifyWritePath(fp);
  if (cls === "governance") denyGovernance(fp);
  if (cls === "allowed") allow();
  denyDeliverable(fp);
}

// ==== Bash: block deliverable-producing / mutating commands ====
if (tool === "Bash") {
  const raw = String(ti.command || "");
  // Strip quoted substrings first so a dispatch brief or echo text (e.g. --brief "run npm build",
  // or a quoted ">") can't trip a deny rule.
  const unquoted = raw.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
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
          `You don't execute the work — dispatch it to the owner (${OWNERS}) via ${DISPATCH}, or ask ${OWNER}. ` +
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
            `Ordinary commits, merges, plain pushes, builds, pm2, and deploys ARE yours (standing grant, 2026-07-05) — ` +
            `if this command is truly needed, ask ${OWNER} in chat first.`
        );
      }
    }

    // 3) Shell redirects (> / >>) are file writes — judge them by their TARGET, same
    //    allow-list as the Write tool. Coordination targets are fine; deliverables/governance
    //    are not. (`2>&1` and other &-redirects are not file targets, so they don't match.)
    const targets = [...seg.matchAll(/>>?\s*([^\s&|;<>]+)/g)].map((m) => m[1]);
    for (const target of targets) {
      // Discard / device sinks are not files to protect (e.g. `2>/dev/null`).
      const nt = norm(target);
      if (["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero", "nul", "con"].includes(nt)) {
        continue;
      }
      const { cls } = classifyWritePath(target);
      if (cls === "governance") denyGovernance(target);
      if (cls === "deliverable") {
        logEvent({ t: new Date().toISOString(), tool, cmd: raw, target, decision: "deny", why: "redirect-deliverable" });
        deny(
          `Blocked by the CVB guard: writing to "${target}" via a shell redirect — that path is a deliverable, not a coordination file. ` +
            `Use the Write tool for coordination files (task boards / briefs under .aiteam/, inbox-shared.md, your memory, vault notes), ` +
            `or dispatch deliverable work to the owner (${OWNERS}) via ${DISPATCH}.`
        );
      }
      // "allowed" → fine, keep scanning.
    }
  }
  allow();
}

// Any other tool (matcher shouldn't send these) — allow.
allow();
