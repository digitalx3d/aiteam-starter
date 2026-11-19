import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig } from "./config";

/**
 * Per-dispatch Live Feed posts.
 *
 * Every agent has one now.md, so two workers of the same agent running at once
 * (a batch job running three or four Caseys) overwrote each
 * other's post and the owner only ever saw whichever slot wrote last. Each dispatch
 * now also owns a post file keyed by its ticket:
 *
 *   <agentsDir>/<agent>/posts/<ticketId>.md    the post, same feed format as now.md
 *   <agentsDir>/<agent>/posts/<ticketId>.json  { label, project, startedAt }
 *
 * Workers still Write their now.md (the format guard validates it there, and the
 * persona and rules all say now.md). The PostToolUse hook
 * scripts/hooks/feed-post.mjs copies each accepted post into the ticket's file
 * from the tool input, so a concurrent writer can never clobber it. The engine's
 * own pickup/done/blocker posts land in both. now.md stays "the latest post from
 * any of this agent's jobs", so single-worker agents, CVB's chat and terminal
 * sessions behave exactly as before.
 *
 * The hooks hard-code the same layout (they are plain .mjs with no imports from
 * here); change POSTS_DIRNAME and you change feed-post.mjs, feed-nudge.mjs and
 * feed-guard.mjs with it.
 */

export const POSTS_DIRNAME = "posts";

// Feed posts run 20-60 words (the posting contract in
// vault/team/operating-rules.md); code-written narrations honor the same cap.
export const MAX_FEED_WORDS = 60;
// The feed header's separator, the em dash the posting contract specifies. Built
// from its code point so this source file carries no literal em dash.
const FEED_SEPARATOR = String.fromCharCode(0x2014);

/** Post files older than this are deleted at the next engine write for that
 *  agent, and ignored by the stream reader in the meantime. The feed log keeps
 *  the history; these files only exist to show what is in flight. */
export const POST_TTL_MS = 24 * 60 * 60 * 1000;

export interface PostMeta {
  ticketId: string;
  agent: string;
  project: string | null;
  /** Human label for the slot, from the brief's title line. */
  label: string;
  startedAt: number;
}

/** Ticket ids are UUIDs; anything else is reduced to filename-safe characters. */
function safeId(ticketId: string): string {
  return ticketId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function postsDir(agent: string): string {
  return path.join(getConfig().agentsDir, agent, POSTS_DIRNAME);
}

export function postPath(agent: string, ticketId: string): string {
  return path.join(postsDir(agent), `${safeId(ticketId)}.md`);
}

function metaPath(agent: string, ticketId: string): string {
  return path.join(postsDir(agent), `${safeId(ticketId)}.json`);
}

export async function writePostMeta(meta: PostMeta): Promise<void> {
  await fsp.mkdir(postsDir(meta.agent), { recursive: true });
  await fsp.writeFile(metaPath(meta.agent, meta.ticketId), JSON.stringify(meta), "utf8");
}

export async function readPostMeta(agent: string, ticketId: string): Promise<PostMeta | null> {
  try {
    const raw = await fsp.readFile(metaPath(agent, ticketId), "utf8");
    const m = JSON.parse(raw);
    return m && typeof m === "object" ? (m as PostMeta) : null;
  } catch {
    return null;
  }
}

/** Ticket ids of this agent's post files younger than POST_TTL_MS. */
export async function listLivePostIds(agent: string, now = Date.now()): Promise<string[]> {
  try {
    const dir = postsDir(agent);
    const out: string[] = [];
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const st = await fsp.stat(path.join(dir, f));
        if (now - st.mtimeMs <= POST_TTL_MS) out.push(f.slice(0, -3));
      } catch {
        /* vanished mid-scan */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Delete this agent's post, meta and nudge-marker files older than POST_TTL_MS.
 *  Best-effort. */
export async function pruneStalePosts(agent: string, now = Date.now()): Promise<void> {
  try {
    const dir = postsDir(agent);
    for (const f of await fsp.readdir(dir)) {
      // .nudge is feed-nudge.mjs's per-ticket cooldown marker.
      if (!/\.(md|json|nudge)$/.test(f)) continue;
      const p = path.join(dir, f);
      try {
        const st = await fsp.stat(p);
        if (now - st.mtimeMs > POST_TTL_MS) await fsp.unlink(p);
      } catch {
        /* vanished or locked; next prune gets it */
      }
    }
  } catch {
    /* no posts dir yet */
  }
}

/**
 * Strip markdown scaffolding from a line the engine is about to post. Reports
 * arrive as bullets with bold labels ("- **Slot resolved to:** ..."), and the
 * auto-done post used to put that straight after the header's separator, which
 * is how the feed got a done post whose sentence began "- **Slot".
 */
export function plainFeedLine(line: string): string {
  return line
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^(?:[-*+•]|\d+[.)])\s+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/`/g, "")
    .replace(/^\*(.+)\*$/, "$1")
    .trim();
}

/**
 * Write a live-feed narration post to the agent's now.md in the feed format
 * ("kind [project]: text", capped at the contract's 20-60 word budget). The
 * live-feed watcher picks up now.md changes, so this makes pickups,
 * completions, and failures show up in the Live Feed even when the agent
 * itself doesn't narrate: e.g. it died before its first turn (an API
 * overload), or it skipped a beat. Non-project dispatches are tagged [aiteam]
 * so every post leads with a project name. Best-effort; never throws into
 * dispatch.
 *
 * The post goes to the ticket's own post file first (what the feed shows per
 * slot), then to now.md (the agent's latest post, as before). Lines are stripped
 * of markdown first, so a bulleted report can't open a post with "- **Label:**".
 * Stale post files for this agent are pruned on the way.
 */
export async function writeNarration(
  agent: string,
  kind: "pickup" | "blocker" | "done",
  project: string | null,
  text: string,
  ticketId: string
): Promise<void> {
  try {
    const dir = path.join(getConfig().agentsDir, agent);
    await fsp.mkdir(dir, { recursive: true });
    const tag = ` [${project ?? "aiteam"}]`;
    // Keep whole lines while they fit the word budget, so agent-authored
    // summaries keep their shape; a line that busts the budget is cut at a
    // word boundary rather than mid-word.
    const lines: string[] = [];
    let budget = MAX_FEED_WORDS;
    for (const raw of text.split(/\r?\n/)) {
      const l = plainFeedLine(raw);
      if (!l) continue;
      const words = l.split(/\s+/);
      if (words.length <= budget) {
        lines.push(l);
        budget -= words.length;
      } else {
        if (budget >= 4) lines.push(words.slice(0, budget).join(" ") + " …");
        break;
      }
      if (budget <= 0) break;
    }
    const head = lines.shift() ?? "";
    const body = lines.length ? "\n" + lines.join("\n") : "";
    const post = `${kind}${tag} ${FEED_SEPARATOR} ${head}${body}\n`;
    try {
      await fsp.mkdir(path.dirname(postPath(agent, ticketId)), { recursive: true });
      await fsp.writeFile(postPath(agent, ticketId), post, "utf8");
    } catch {
      /* now.md below still carries it */
    }
    await fsp.writeFile(path.join(dir, "now.md"), post, "utf8");
    await pruneStalePosts(agent);
  } catch {
    /* best-effort: a narration write must never break dispatch */
  }
}

/** True if this ticket's own post file already shows a "done" post written after
 *  `sinceMs` (i.e. during this run), in which case the code-driven completion post
 *  would only overwrite a richer, agent-authored one. Reads the ticket's file, not
 *  now.md: with parallel workers now.md may hold a sibling slot's "done", which
 *  used to suppress this slot's finish post entirely. Any error reads as "no". */
export async function postedDoneSince(
  agent: string,
  ticketId: string,
  sinceMs: number
): Promise<boolean> {
  try {
    const p = postPath(agent, ticketId);
    const stat = await fsp.stat(p);
    if (stat.mtimeMs < sinceMs) return false;
    const firstLine = (await fsp.readFile(p, "utf8")).split(/\r?\n/)[0] ?? "";
    return /^done\b/i.test(firstLine.trim());
  } catch {
    return false;
  }
}
