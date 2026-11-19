#!/usr/bin/env node
/*
 * feed-post.mjs: PostToolUse (Write) mirror from now.md into the dispatch's own
 * Live Feed post file.
 *
 * Every agent has one now.md. When a batch job runs three or
 * four Caseys at once, they all Write that one file and the owner only sees whichever
 * slot wrote last. Each dispatched worker is spawned with its ticket id
 * (app/src/lib/worker-hooks.ts), and after every successful Write to the
 * agent's OWN now.md this hook copies the post into
 *
 *   <agents-dir>/<agent>/posts/<ticket>.md
 *
 * which the Live Feed reader treats as that slot's post. The copy is taken from
 * the tool input, not re-read from disk, so a sibling that overwrites now.md a
 * millisecond later cannot clobber it. Format and ownership were already checked
 * by feed-guard.mjs before the Write ran; PostToolUse only fires when the Write
 * succeeded, so nothing a guard denied ever gets mirrored.
 *
 * Layout shared with app/src/lib/feed-posts.ts (POSTS_DIRNAME = "posts").
 *
 * Invocation: node feed-post.mjs --agent <name> --ticket <id> --agents-dir <path>
 * Fail-open: any error => exit 0, no output. A broken mirror never breaks a run.
 */
import fs from "node:fs";
import path from "node:path";

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

const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();

try {
  const flags = parseArgs(process.argv.slice(2));
  const agent = typeof flags.agent === "string" ? flags.agent.toLowerCase() : null;
  const ticket = typeof flags.ticket === "string" ? flags.ticket : null;
  const agentsDir = typeof flags["agents-dir"] === "string" ? flags["agents-dir"] : null;
  if (!agent || !ticket || !agentsDir || !/^[A-Za-z0-9_-]+$/.test(ticket)) process.exit(0);

  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!input || input.tool_name !== "Write") process.exit(0);
  const ti = input.tool_input || {};
  let fp = String(ti.file_path || "");
  if (!fp || typeof ti.content !== "string") process.exit(0);
  if (!path.isAbsolute(fp) && input.cwd) fp = path.join(input.cwd, fp);

  // Only the agent's own now.md. Anything else is none of this hook's business.
  if (norm(fp) !== norm(path.join(agentsDir, agent, "now.md"))) process.exit(0);

  const dir = path.join(agentsDir, agent, "posts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ticket}.md`), ti.content, "utf8");
} catch {
  /* fail-open */
}
process.exit(0);
