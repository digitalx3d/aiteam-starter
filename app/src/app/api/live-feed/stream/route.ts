import path from "node:path";
import { promises as fsp } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { getConfig } from "@/lib/config";
import { POSTS_DIRNAME, listLivePostIds, postPath, readPostMeta } from "@/lib/feed-posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-agent files live at user level — same dir Claude Code reads subagents from.
// Config is read per call: a settings change applies on stream reconnect.
function agentsDirPath(): string {
  return getConfig().agentsDir;
}
function feedLogPath(): string {
  return path.join(agentsDirPath(), "live-feed.jsonl");
}

type Kind = "pickup" | "working" | "discovery" | "pivot" | "blocker" | "done" | "other";

interface NarrationEvent {
  type: "narration";
  ts: number;
  agent: string;
  kind: Kind;
  text: string;
  project?: string;
  /** Dispatch ticket id, when the post came from a dispatched worker's own post
   *  file. Two parallel workers of the same agent have different slots. */
  slot?: string;
  /** Human label for the slot (the brief's title line). */
  label?: string;
}

const KNOWN_KINDS: ReadonlySet<Kind> = new Set([
  "pickup",
  "working",
  "discovery",
  "pivot",
  "blocker",
  "done",
]);

function parseNow(raw: string): { kind: Kind; text: string; project?: string } | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const first = lines[0];
  if (!first) return null;
  // Posts are capped at 20-60 words by the posting contract; keep the whole
  // post. The slice/char caps below are only a safety net against unhooked
  // writers dumping walls of text into a now.md.
  const rest = lines
    .slice(1)
    .filter(Boolean)
    .slice(0, 14)
    .map((l) => (l.length <= 600 ? l : l.slice(0, 597) + "..."));
  // Header supports the [project] tag: `working [my-app] — text`
  const m = first.match(/^([a-z]+)\s*(?:\[([^\]]+)\])?\s*(?:—|--|-)\s*(.+)$/i);
  if (!m) return { kind: "other", text: [first, ...rest].join("\n") };
  const kindRaw = m[1].toLowerCase() as Kind;
  const kind = KNOWN_KINDS.has(kindRaw) ? kindRaw : "other";
  return {
    kind,
    text: [m[3].trim(), ...rest].join("\n"),
    project: m[2]?.trim() || undefined,
  };
}

async function listAgentSlugs(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(agentsDirPath(), { withFileTypes: true });
    return entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

async function readNow(agent: string): Promise<NarrationEvent | null> {
  const filePath = path.join(agentsDirPath(), agent, "now.md");
  try {
    const stat = await fsp.stat(filePath);
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = parseNow(raw);
    if (!parsed) return null;
    return {
      type: "narration",
      ts: stat.mtimeMs,
      agent,
      kind: parsed.kind,
      text: parsed.text,
      project: parsed.project,
    };
  } catch {
    return null;
  }
}

/** One dispatch's own post (posts/<ticket>.md), labelled from its meta file. */
async function readPost(agent: string, ticketId: string): Promise<NarrationEvent | null> {
  try {
    const filePath = postPath(agent, ticketId);
    const stat = await fsp.stat(filePath);
    const parsed = parseNow(await fsp.readFile(filePath, "utf8"));
    if (!parsed) return null;
    const meta = await readPostMeta(agent, ticketId);
    return {
      type: "narration",
      ts: stat.mtimeMs,
      agent,
      kind: parsed.kind,
      text: parsed.text,
      project: parsed.project,
      slot: ticketId,
      label: meta?.label || undefined,
    };
  } catch {
    return null;
  }
}

// A worker's post lands in now.md AND in its ticket's post file (feed-post.mjs
// copies it a moment after the Write). The slot event is the one worth keeping,
// since it carries the label, so a now.md change that just repeats a recent slot
// post is dropped. Window is generous: the copy runs in a separate hook process.
const NOW_DUP_WINDOW_MS = 2 * 60 * 1000;
// now.md waits this long before it is read, so the slot copy is on disk first.
const NOW_SETTLE_MS = 1500;

async function duplicatesSlotPost(evt: NarrationEvent): Promise<boolean> {
  for (const id of await listLivePostIds(evt.agent)) {
    const post = await readPost(evt.agent, id);
    if (
      post &&
      post.kind === evt.kind &&
      post.text === evt.text &&
      Math.abs(post.ts - evt.ts) <= NOW_DUP_WINDOW_MS
    ) {
      return true;
    }
  }
  return false;
}

/** Dedupe key: one per agent for now.md, one per agent and slot for post files. */
function feedKey(evt: Pick<NarrationEvent, "agent" | "slot">): string {
  return evt.slot ? `${evt.agent}/${evt.slot}` : evt.agent;
}

interface SeenState {
  ts: Map<string, number>;
  text: Map<string, string>;
}

/** True (and recorded) if evt is new to this state: a different write than the
 *  last one seen for its key, and for a slot, not a re-post of identical text
 *  (an agent retrying a Write after a sibling touched now.md re-sends it). */
function isNewTo(seen: SeenState, evt: NarrationEvent): boolean {
  const key = feedKey(evt);
  if (seen.ts.get(key) === evt.ts) return false;
  const sig = `${evt.kind}\n${evt.text}`;
  if (evt.slot && seen.text.get(key) === sig) return false;
  seen.ts.set(key, evt.ts);
  seen.text.set(key, sig);
  return true;
}

// Module-level: shared across SSE connections in the same Node process, so each
// write is appended to the feed log once even though every open connection has
// its own watcher. Sending is tracked per connection (see GET); sharing that too
// meant two open dashboards split the live events between them.
const logged: SeenState = { ts: new Map(), text: new Map() };
const lastLoggedTs = logged.ts;
const lastLoggedText = logged.text;

async function appendToFeedLog(evt: NarrationEvent): Promise<void> {
  try {
    await fsp.mkdir(agentsDirPath(), { recursive: true });
    await fsp.appendFile(feedLogPath(), JSON.stringify(evt) + "\n", "utf8");
  } catch {
    // best effort
  }
}

async function readRecentFromFeedLog(limit = 50): Promise<NarrationEvent[]> {
  try {
    const raw = await fsp.readFile(feedLogPath(), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-limit);
    const out: NarrationEvent[] = [];
    for (const l of tail) {
      try {
        const obj = JSON.parse(l);
        if (obj && obj.type === "narration") out.push(obj as NarrationEvent);
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}

function sseFrame(data: string): Uint8Array {
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

export async function GET(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (frame: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(frame);
        } catch {
          closed = true;
        }
      };

      // Hello + history replay so the panel populates immediately on connect
      safeEnqueue(
        sseFrame(JSON.stringify({ type: "hello", ts: Date.now() }))
      );

      const history = await readRecentFromFeedLog(500);
      for (const evt of history) {
        safeEnqueue(sseFrame(JSON.stringify(evt)));
      }

      // Seed dedupe map from history so we don't re-log known events after a restart.
      for (const evt of history) {
        const key = feedKey(evt);
        const prior = lastLoggedTs.get(key) ?? 0;
        if (evt.ts > prior) {
          lastLoggedTs.set(key, evt.ts);
          lastLoggedText.set(key, `${evt.kind}\n${evt.text}`);
        }
      }

      // Send each agent's current now.md, and each in-flight slot's post, as the
      // latest state. (Helps after a restart where the JSONL might lag the files.)
      const agents = await listAgentSlugs();
      for (const agent of agents) {
        const current: NarrationEvent[] = [];
        for (const id of await listLivePostIds(agent)) {
          const post = await readPost(agent, id);
          if (post) current.push(post);
        }
        const nowEvt = await readNow(agent);
        if (nowEvt && !(await duplicatesSlotPost(nowEvt))) current.push(nowEvt);
        for (const evt of current.sort((a, b) => a.ts - b.ts)) {
          const key = feedKey(evt);
          const prior = lastLoggedTs.get(key) ?? 0;
          if (evt.ts > prior) {
            lastLoggedTs.set(key, evt.ts);
            lastLoggedText.set(key, `${evt.kind}\n${evt.text}`);
            safeEnqueue(sseFrame(JSON.stringify(evt)));
          }
        }
      }

      const heartbeat = setInterval(() => {
        safeEnqueue(new TextEncoder().encode(": ping\n\n"));
      }, 15000);

      const watchers: FSWatcher[] = [];
      const emitTimers = new Map<string, NodeJS.Timeout>();
      // What this connection has been sent, seeded with the replay above.
      const sent: SeenState = { ts: new Map(lastLoggedTs), text: new Map(lastLoggedText) };

      // slot = ticket id for a posts/<ticket>.md change, null for now.md.
      const debouncedEmit = (agent: string, slot: string | null) => {
        const key = slot ? `${agent}/${slot}` : agent;
        const prior = emitTimers.get(key);
        if (prior) clearTimeout(prior);
        const t = setTimeout(
          async () => {
            emitTimers.delete(key);
            const evt = slot ? await readPost(agent, slot) : await readNow(agent);
            if (!evt) return;
            if (!slot && (await duplicatesSlotPost(evt))) return; // the slot event has it
            if (isNewTo(logged, evt)) await appendToFeedLog(evt); // first watcher logs it
            if (!isNewTo(sent, evt)) return; // already on this connection
            safeEnqueue(sseFrame(JSON.stringify(evt)));
          },
          slot ? 150 : NOW_SETTLE_MS
        );
        emitTimers.set(key, t);
      };

      // Watch the agents/ directory recursively. When agents/<name>/now.md
      // is changed (or created), Node fires (eventType, filename) where
      // filename is the relative path from AGENTS_DIR.
      try {
        const w = watch(
          agentsDirPath(),
          { persistent: false, recursive: true },
          (_eventType, filename) => {
            if (!filename) return;
            const rel = filename.toString().replace(/\\/g, "/");
            const m = rel.match(/^([^/]+)\/now\.md$/);
            if (m) return debouncedEmit(m[1], null);
            const p = rel.match(new RegExp(`^([^/]+)/${POSTS_DIRNAME}/([A-Za-z0-9_-]+)\\.md$`));
            if (p) debouncedEmit(p[1], p[2]);
          }
        );
        w.on("error", () => {});
        watchers.push(w);
      } catch (err) {
        safeEnqueue(
          sseFrame(
            JSON.stringify({
              type: "error",
              ts: Date.now(),
              message: `failed to set up watcher: ${(err as Error).message}`,
            })
          )
        );
      }

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        for (const t of emitTimers.values()) clearTimeout(t);
        emitTimers.clear();
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            /* noop */
          }
        }
        try {
          controller.close();
        } catch {
          /* noop */
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
