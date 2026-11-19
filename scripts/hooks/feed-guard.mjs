#!/usr/bin/env node
/*
 * feed-guard.mjs — PreToolUse format guard for Live Feed posts (now.md).
 *
 * Wired into every dispatched worker (via --settings, generated per spawn by
 * app/src/lib/worker-hooks.ts) and into CVB's chat sessions (cvb-hooks.ts).
 * Runs as CODE before every Edit/Write/MultiEdit/NotebookEdit/Bash, so the
 * Live Feed posting contract cannot be rationalized away mid-session the way
 * a persona rule can.
 *
 * The contract it enforces (canon: vault/team/operating-rules.md "Live Feed"):
 *   - now.md is replaced wholesale with the Write tool. Edit/Bash writes are
 *     rejected and redirected to Write, so every post passes this check.
 *   - First line: `<kind> [<project>] — <plain-English sentence>`. Kind must be
 *     one of pickup/working/discovery/pivot/blocker/done/standby. The [project]
 *     tag is REQUIRED and must match the project the agent was dispatched for
 *     (`--project any` relaxes the value check but still requires a tag).
 *   - 20-60 words of plain English (standby may be shorter). The owner reads these;
 *     they are written for a business owner, not a developer:
 *       - no coder symbols (+ -> => & | < > # * ` ~ = _ @ \) — write the words
 *       - no bare acronyms or ALL-CAPS shorthand; teach shorthand as
 *         "full name (ACRONYM)" — in parentheses it is allowed
 *   - An agent may only post to its OWN now.md.
 *
 * Invocation: node feed-guard.mjs --agent <name> --project <label|any> --agents-dir <path>
 *
 * Deny contract: exit 0 with {hookSpecificOutput:{permissionDecision:"deny",...}}.
 * The reason teaches the correct format so the agent fixes the post and retries.
 * Fail-open: unparseable input or missing args => allow; a broken guard must
 * never brick a worker.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

const KINDS = ["pickup", "working", "discovery", "pivot", "blocker", "done", "standby"];
const MIN_WORDS = 20;
const MAX_WORDS = 60;
const MAX_LINE_CHARS = 500;
// Characters that read as code, not English. Hyphens, slashes, %, $ and
// normal punctuation stay legal; the em dash in the header is scaffolding,
// stripped before this check runs.
const CODE_SYMBOLS = /[+&|<>*#`~=_@\\^]/;
// All-caps tokens this length read as acronyms. Longer all-caps tokens
// (CRITICAL, PASSED) read as emphasis on real words and are left alone.
const ACRONYM = /\b[A-Z]{2,5}\b/g;
// Shorthand the owner already knows; everything else gets spelled out first.
const KNOWN_ACRONYMS = new Set(["AI", "CVB", "OK", "ID", "USD", "PDF", "URL", "HIGH", "LOW"]);

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

function allow() {
  // No output + exit 0 = defer to the normal permission flow.
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

function norm(p) {
  return String(p).replace(/\\/g, "/").toLowerCase();
}

const flags = parseArgs(process.argv.slice(2));
const AGENT = typeof flags.agent === "string" ? flags.agent.toLowerCase() : null;
const PROJECT = typeof flags.project === "string" ? flags.project : null;
const AGENTS_DIR = typeof flags["agents-dir"] === "string" ? norm(flags["agents-dir"]) : null;
if (!AGENT || !PROJECT || !AGENTS_DIR) allow(); // fail-open on bad wiring

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  allow();
}
if (!input || typeof input !== "object") allow();

const tool = input.tool_name;
const ti = input.tool_input || {};

/** If fp is some agent's now.md under AGENTS_DIR, return that agent's slug; else null. */
function nowMdOwner(fp) {
  if (!fp) return null;
  let p = String(fp);
  if (!path.isAbsolute(p) && input.cwd) p = path.join(input.cwd, p);
  const n = norm(p);
  if (!n.endsWith("/now.md")) return null;
  if (!n.startsWith(AGENTS_DIR + "/")) return null;
  const rel = n.slice(AGENTS_DIR.length + 1); // "<agent>/now.md"
  const parts = rel.split("/");
  return parts.length === 2 ? parts[0] : null;
}

function exampleFor(kind) {
  const proj = PROJECT === "any" ? "my-app" : PROJECT;
  return (
    `${kind} [${proj}] — Halfway through the menu fix.\n` +
    `I traced the squished header to a sizing rule and rewrote that section, so phone screens read correctly now.\n` +
    `Tablet widths are next, then a final check across the whole app.`
  );
}

function denyPost(problem, kind = "working") {
  deny(
    `Live Feed post rejected: ${problem}\n` +
      `A post is 20-60 words of plain English ${OWNER} can skim. First line: ` +
      `"<kind> [<project>] — <one plain sentence>" where kind is one of ` +
      `${KINDS.join("/")} and the project tag is "${PROJECT === "any" ? "<the project this work is for>" : PROJECT}". ` +
      `Follow with what you did, what you found, and what's next — no tool mechanics, ` +
      `no file-by-file minutiae, no coder symbols (write "and" not "+", "to" not "->"), ` +
      `and no bare acronyms: write the full name, then the shorthand in parentheses, ` +
      `like "window controls overlay (WCO)". (standby may be shorter.) Example:\n` +
      exampleFor(kind) +
      `\nFix the post and Write it again.`
  );
}

/** Validate a full now.md replacement. Calls denyPost (which exits) on violation. */
function validatePost(content) {
  const lines = String(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) denyPost("the post is empty.");

  const m = lines[0].match(/^([a-z]+)\s*(?:\[([^\]]+)\])?\s*(?:—|--|-)\s*(\S.*)$/i);
  if (!m) {
    denyPost(
      `the first line must be "<kind> [<project>] — <sentence>" (got: "${lines[0].slice(0, 120)}").`
    );
  }
  const kind = m[1].toLowerCase();
  const tag = m[2] ? m[2].trim() : null;

  if (!KINDS.includes(kind)) {
    denyPost(`"${kind}" is not a valid kind (use ${KINDS.join("/")}).`);
  }
  if (!tag) {
    denyPost(`the [project] tag is missing — every post starts with the project name.`, kind);
  }
  if (PROJECT !== "any" && tag.toLowerCase() !== PROJECT.toLowerCase()) {
    denyPost(
      `the project tag is [${tag}] but this dispatch is for [${PROJECT}] — tag posts with the project you were dispatched for.`,
      kind
    );
  }

  // The body = the first-line sentence plus every following line. The kind,
  // tag, and separator are scaffolding and don't count toward the word budget.
  const body = [m[3], ...lines.slice(1)].join("\n").trim();
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  if (kind !== "standby" && wordCount < MIN_WORDS) {
    denyPost(
      `only ${wordCount} word${wordCount === 1 ? "" : "s"} — too thin to be useful. Write ${MIN_WORDS}-${MAX_WORDS} words: what you did, what you found, what's next.`,
      kind
    );
  }
  if (wordCount > MAX_WORDS) {
    denyPost(
      `${wordCount} words — too long for the feed. Trim to the ${MIN_WORDS}-${MAX_WORDS} words that matter; details belong in your report, not the feed.`,
      kind
    );
  }

  const sym = body.match(CODE_SYMBOLS);
  if (sym) {
    denyPost(
      `it contains "${sym[0]}" — coder symbols don't belong in the feed. Write it out in words: "and" not "+", "to" not "->", "version 7 to version 8" not "v7->v8".`,
      kind
    );
  }

  // Acronym check: parenthesized shorthand is the teaching form and is fine;
  // anything bare must be spelled out first.
  const outsideParens = body.replace(/\([^)]*\)/g, " ");
  const caps = (outsideParens.match(ACRONYM) || []).filter((t) => !KNOWN_ACRONYMS.has(t));
  if (caps.length > 0) {
    denyPost(
      `"${caps[0]}" is bare shorthand — ${OWNER} shouldn't need a decoder ring. Write the full name in plain words, then the shorthand in parentheses after it, like "window controls overlay (WCO)". Same for all-caps emphasis: use normal sentence case.`,
      kind
    );
  }

  const tooLong = lines.find((l) => l.length > MAX_LINE_CHARS);
  if (tooLong) {
    denyPost(`one line runs ${tooLong.length} characters — break the post into shorter lines.`, kind);
  }
  allow();
}

// ==== Edit family: now.md must be replaced wholesale via Write ====
if (["Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const fp = ti.file_path || ti.notebook_path || ti.path || "";
  if (nowMdOwner(fp)) {
    deny(
      `now.md is your live status post, not a document to patch — replace it wholesale with the Write tool ` +
        `(20-60 words of plain English, first line "<kind> [${PROJECT === "any" ? "<project>" : PROJECT}] — <sentence>").`
    );
  }
  allow();
}

// ==== Write: validate own posts; block posting as someone else ====
if (tool === "Write") {
  const owner = nowMdOwner(ti.file_path || "");
  if (!owner) allow();
  if (owner !== AGENT) {
    deny(
      `That is ${owner}'s now.md — you only post to your own Live Feed file. ` +
        `Surface anything for a teammate in your report instead.`
    );
  }
  validatePost(ti.content ?? "");
}

// ==== Bash: writes that target now.md dodge the format check — redirect to Write ====
if (tool === "Bash") {
  const raw = String(ti.command || "");
  if (/now\.md/i.test(raw)) {
    // Reads (cat/grep/stat) are fine; anything write-shaped gets redirected to Write.
    const writeShaped =
      /(>>?\s*[^\s&|;<>]*now\.md)|\b(tee|mv|cp|rm|sed|touch|set-content|add-content|out-file)\b[^\n]*now\.md/i.test(
        raw
      );
    if (writeShaped) {
      deny(
        `Don't write now.md from the shell — use the Write tool so the Live Feed format check can run ` +
          `(20-60 words of plain English, first line "<kind> [${PROJECT === "any" ? "<project>" : PROJECT}] — <sentence>").`
      );
    }
  }
  allow();
}

// Any other tool — allow.
allow();
