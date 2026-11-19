// Live Feed hooks: per-dispatch posts (feed-post.mjs), per-ticket silence
// (feed-nudge.mjs), and the guard rules that keep them honest (feed-guard.mjs).
// Runs every hook exactly as Claude Code does: JSON on stdin,
// flags on argv. Uses a throwaway agents folder, never the real one.
//
//   node scripts/hooks/feed-hooks.test.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, "/");
const AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), "feed-hooks-")).replace(/\\/g, "/");
const CWD = "C:/Code/bakery-site";
for (const a of ["casey", "devin"]) fs.mkdirSync(`${AGENTS}/${a}/posts`, { recursive: true });

function hook(name, args, payload) {
  const r = spawnSync("node", [`${HOOKS}/${name}`, ...args], {
    input: JSON.stringify({ cwd: CWD, ...payload }),
    encoding: "utf8",
  });
  const out = (r.stdout || "").trim();
  if (!out) return { d: "allow" };
  try {
    const h = JSON.parse(out).hookSpecificOutput;
    return { d: h.permissionDecision ?? "context", r: h.permissionDecisionReason ?? h.additionalContext };
  } catch {
    return { d: "parse-error", r: out };
  }
}

const base = (agent, ticket) => [
  "--agent", agent, "--project", "bakery-site", "--agents-dir", AGENTS,
  ...(ticket ? ["--ticket", ticket] : []),
];

const GOOD =
  "working [bakery-site] -- Halfway through the Weekend menu page.\n" +
  "I have the photos and both price lists saved, and the opening hours are next, then the order form.";
const BAD = "done [bakery-site] -- - **Slot resolved to:** M12 Sourdough Loaf, moved to the weekend menu by the owner.";

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${got}, want ${want})`}`);
}

// ---- feed-guard: format and ownership, unchanged ----
const g = (tool, input) => hook("feed-guard.mjs", base("casey"), { tool_name: tool, tool_input: input }).d;
check("guard: own now.md, good post", g("Write", { file_path: `${AGENTS}/casey/now.md`, content: GOOD }), "allow");
check("guard: own now.md, markdown first line", g("Write", { file_path: `${AGENTS}/casey/now.md`, content: BAD }), "deny");
check("guard: another agent's now.md", g("Write", { file_path: `${AGENTS}/devin/now.md`, content: GOOD }), "deny");
check("guard: Edit on own now.md", g("Edit", { file_path: `${AGENTS}/casey/now.md`, old_string: "a", new_string: "b" }), "deny");
// ---- feed-guard: posts/ is written for the agent, never by it ----
check("guard: Write own posts file", g("Write", { file_path: `${AGENTS}/casey/posts/t1.md`, content: GOOD }), "deny");
check("guard: Write another agent's posts file", g("Write", { file_path: `${AGENTS}/devin/posts/t1.md`, content: GOOD }), "deny");
check("guard: shell write into posts", g("Bash", { command: "echo hi > C:/Users/demo/.claude/agents/casey/posts/t1.md" }), "deny");
check("guard: shell append mentioning posts in prose",
  g("Bash", { command: "cat >> C:/Code/aiTeam/inbox-shared.md <<'EOF'\n- writes `C:\\Users\\demo\\.claude\\agents\\<name>\\posts\\<ticket>.md`\nEOF" }), "allow");
check("guard: shell read of posts",g("Bash", { command: "cat C:/Users/demo/.claude/agents/casey/posts/t1.md" }), "allow");
// ---- feed-guard: look-alike home folders ----
check("guard: aiTeam/casey/now.md", g("Write", { file_path: "C:/Code/aiTeam/casey/now.md", content: GOOD }), "deny");
check("guard: aiTeam/casey build script", g("Write", { file_path: "C:/Code/aiTeam/casey/build-x.mjs", content: "x" }), "deny");
check("guard: aiTeam/agents/casey/completed.md", g("Write", { file_path: "C:\\Code\\aiTeam\\agents\\casey\\completed.md", content: "x" }), "deny");
check("guard: C:/aiTeam/agents/casey/completed.md", g("Write", { file_path: "C:/aiTeam/agents/casey/completed.md", content: "x" }), "deny");
check("guard: relative casey/now.md from the project", g("Write", { file_path: "casey/now.md", content: GOOD }), "deny");
check("guard: real home completed.md", g("Write", { file_path: `${AGENTS}/casey/completed.md`, content: "x" }), "allow");
check("guard: real home script", g("Write", { file_path: `${AGENTS}/casey/scratch/build-x.mjs`, content: "x" }), "allow");
check("guard: project output", g("Write", { file_path: "C:/Code/bakery-site/players/x/sources.csv", content: "x" }), "allow");
check("guard: vault notebook", g("Write", { file_path: "C:/Code/vault/agents/casey/notes/x.md", content: "x" }), "allow");
check("guard: project override persona", g("Write", { file_path: "C:/Code/bakery-site/.aiteam/agents/casey.md", content: "x" }), "allow");
check("guard: devin may write aiTeam/casey (not his look-alike)",
  hook("feed-guard.mjs", base("devin"), { tool_name: "Write", tool_input: { file_path: "C:/Code/aiTeam/casey/x.md", content: "x" } }).d, "allow");

// ---- feed-post: each ticket keeps its own copy ----
const post = (agent, ticket, file_path, content) =>
  hook("feed-post.mjs", base(agent, ticket), { tool_name: "Write", tool_input: { file_path, content } });
const A = GOOD.replace("Weekend", "Holiday");
const B = GOOD.replace("Weekend", "Catering");
post("casey", "slot-a", `${AGENTS}/casey/now.md`, A);
post("casey", "slot-b", `${AGENTS}/casey/now.md`, B);
check("post: slot A kept its own post", fs.readFileSync(`${AGENTS}/casey/posts/slot-a.md`, "utf8"), A);
check("post: slot B kept its own post", fs.readFileSync(`${AGENTS}/casey/posts/slot-b.md`, "utf8"), B);
post("casey", "slot-c", `${AGENTS}/casey/notes.md`, A);
check("post: non-now.md write not copied", fs.existsSync(`${AGENTS}/casey/posts/slot-c.md`), false);
post("casey", "slot-d", `${AGENTS}/devin/now.md`, A);
check("post: other agent's now.md not copied", fs.existsSync(`${AGENTS}/casey/posts/slot-d.md`), false);
post("casey", "../evil", `${AGENTS}/casey/now.md`, A);
check("post: unsafe ticket id ignored", fs.existsSync(`${AGENTS}/casey/evil.md`), false);

// ---- feed-nudge: silence measured per ticket ----
const nudge = (ticket) => hook("feed-nudge.mjs", base("casey", ticket), { tool_name: "Read", tool_input: {} }).d;
const old = new Date(Date.now() - 20 * 60_000);
fs.writeFileSync(`${AGENTS}/casey/now.md`, B); // a sibling just posted
fs.utimesSync(`${AGENTS}/casey/posts/slot-a.md`, old, old); // slot A went quiet 20 min ago
check("nudge: quiet slot nudged though now.md is fresh", nudge("slot-a"), "context");
check("nudge: cooldown holds the repeat", nudge("slot-a"), "allow");
check("nudge: fresh slot left alone", nudge("slot-b"), "allow");
check("nudge: no ticket, fresh now.md, left alone", nudge(null), "allow");

fs.rmSync(AGENTS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
