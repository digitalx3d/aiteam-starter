// cvb-guard.test.mjs: what CVB's guard must allow and what it must keep blocked.
//
//   node scripts/hooks/cvb-guard.test.mjs
//
// Self-contained: copies the guard into a temp folder next to a config rendered
// from cvb-guard.config.template.json with made-up paths (the same rendering
// setup.mjs does), so it never reads or depends on your real config.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Made-up install: projects under C:/Code, home at C:/Users/demo.
const T = {
  "{{AITEAM_DIR}}": "c:/code/aiteam",
  "{{AITEAM_DIR_GITBASH}}": "/c/code/aiteam",
  "{{VAULT_DIR}}": "c:/code/vault",
  "{{VAULT_DIR_GITBASH}}": "/c/code/vault",
  "{{AGENTS_DIR}}": "c:/users/demo/.claude/agents",
  "{{AGENTS_DIR_GITBASH}}": "/c/users/demo/.claude/agents",
  "{{PROJECTS_ROOT}}": "c:/code",
  "{{PROJECTS_ROOT_GITBASH}}": "/c/code",
  "{{CLAUDE_DIR}}": "c:/users/demo/.claude",
  "{{CLAUDE_DIR_GITBASH}}": "/c/users/demo/.claude",
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvb-guard-test-"));
let cfg = fs.readFileSync(path.join(HERE, "cvb-guard.config.template.json"), "utf8");
for (const [k, v] of Object.entries(T)) cfg = cfg.split(k).join(v);
JSON.parse(cfg); // the rendered template must be valid JSON
fs.writeFileSync(path.join(dir, "cvb-guard.config.json"), cfg);
fs.copyFileSync(path.join(HERE, "cvb-guard.mjs"), path.join(dir, "cvb-guard.mjs"));
const GUARD = path.join(dir, "cvb-guard.mjs");
const CWD = "C:/Code/bakery-site";

function run(tool_name, tool_input) {
  const r = spawnSync("node", [GUARD], {
    input: JSON.stringify({ tool_name, tool_input, cwd: CWD }),
    encoding: "utf8",
  });
  const out = (r.stdout || "").trim();
  if (!out) return { d: "allow" };
  try {
    const j = JSON.parse(out);
    return { d: j.hookSpecificOutput.permissionDecision, r: j.hookSpecificOutput.permissionDecisionReason };
  } catch {
    return { d: "parse-error", r: out };
  }
}

const cases = [
  // ---- Notes and coordination: allowed ----
  ["allow", "Write", { file_path: "C:/Code/bakery-site/marketing/pricing-analysis.md" }, "analysis note"],
  ["allow", "Write", { file_path: "C:/Users/demo/.claude/agents/devin/inbox.md" }, "teammate inbox"],
  ["allow", "Write", { file_path: "/c/Users/demo/.claude/agents/devin/inbox.md" }, "teammate inbox (git-bash path)"],
  ["allow", "Write", { file_path: "C:/Code/bakery-site/docs/rollout-plan.md" }, "plan doc"],
  ["allow", "Write", { file_path: "C:/Code/aiteam/notes.txt" }, "root note"],
  ["allow", "Write", { file_path: "C:/Code/aiteam/inbox-shared.md" }, "owner inbox"],
  ["allow", "Write", { file_path: "C:/Code/bakery-site/.aiteam/tasks/t-1.md" }, "task file"],
  ["allow", "Write", { file_path: "/tmp/devin-brief.md" }, "staged brief in temp"],
  ["allow", "Bash", { command: "node scripts/x.mjs > /tmp/live.txt 2>/tmp/err.txt" }, "capture output to temp"],
  ["allow", "Bash", { command: "node scripts/check.mjs > audit/run.log 2>&1" }, "capture output to .log"],
  ["allow", "Bash", { command: "pm2 jlist > applist.txt" }, "capture to .txt"],

  // ---- ">" inside code is a comparison, not a redirect ----
  ["allow", "Bash", { command: "node -e 'if (g > 60) gaps.push({at:i,sec:g.toFixed(0)})'" }, "comparison in quoted JS"],
  ["allow", "Bash", { command: "node -e \"const n = codes[s]=(codes[s]>0)?1:-1\"" }, "comparison, double quotes"],
  ["allow", "Bash", { command: "echo `date` && awk '$3 > 100 {print}' file.txt" }, "backticks and awk comparison"],
  ["allow", "Bash", { command: "git log --oneline | head -5" }, "plain read"],
  ["allow", "Bash", { command: "npm run build && pm2 restart aiteam" }, "standing release grant"],
  ["allow", "Bash", { command: "git add -A && git commit -m \"fix > thing\" && git push" }, "ordinary git"],

  // ---- Deliverables and governance: still blocked ----
  ["deny", "Write", { file_path: "C:/Code/bakery-site/landing/index.html" }, "production markup"],
  ["deny", "Write", { file_path: "C:/Code/bakery-site/scripts/build-blog.cjs" }, "build script"],
  ["deny", "Write", { file_path: "C:/Code/bakery-site/src/app.tsx" }, "source code"],
  ["deny", "Write", { file_path: "C:/Code/bakery-site/src/config/data.json" }, "json inside src/"],
  ["deny", "Write", { file_path: "C:/Code/bakery-site/content/blog/my-article.md" }, "Casey's article body"],
  ["deny", "Write", { file_path: "C:/Code/bakery-site/package.json" }, "project config"],
  ["deny", "Write", { file_path: "C:/Code/bakery-site/firestore.rules" }, "security rules"],
  ["deny", "Write", { file_path: "C:/Code/vault/team/operating-rules.md" }, "governance (vault/team)"],
  ["deny", "Write", { file_path: "C:/Users/demo/.claude/agents/devin/soul.md" }, "governance (persona)"],
  ["deny", "Write", { file_path: "C:/Code/bakery-site/public/hero.png" }, "image"],
  ["deny", "Write", { file_path: "D:/Elsewhere/notes.md" }, "note outside the allowed roots"],
  ["deny", "Bash", { command: "cat foo > C:/Code/bakery-site/src/index.js" }, "redirect into src"],
  ["deny", "Bash", { command: "rm -rf build" }, "rm"],
  ["deny", "Bash", { command: "git push --force origin main" }, "force push"],
  ["deny", "Bash", { command: "git reset --hard HEAD~1" }, "history surgery"],
  ["deny", "Bash", { command: "python generate_hero.py" }, "image-gen python"],
];

let pass = 0, fail = 0;
for (const [want, tool, ti, label] of cases) {
  const got = run(tool, ti);
  const ok = got.d === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  want=${want.padEnd(5)} got=${String(got.d).padEnd(5)}  ${label}`);
  if (!ok && got.r) console.log(`        reason: ${got.r.slice(0, 160)}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
