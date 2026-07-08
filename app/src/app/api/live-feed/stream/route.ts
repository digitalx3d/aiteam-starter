import path from "node:path";
import { promises as fsp } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { getConfig } from "@/lib/config";

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
  // Header supports the [project] tag: `working [carpoolq] — text`
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

// Module-level dedupe: shared across SSE connections in the same Node process.
// Prevents leaked filesystem watchers from logging the same now.md write multiple times.
const lastLoggedTs = new Map<string, number>();

function shouldEmit(evt: NarrationEvent): boolean {
  const last = lastLoggedTs.get(evt.agent);
  if (last === evt.ts) return false;
  lastLoggedTs.set(evt.agent, evt.ts);
  return true;
}

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
        const prior = lastLoggedTs.get(evt.agent) ?? 0;
        if (evt.ts > prior) lastLoggedTs.set(evt.agent, evt.ts);
      }

      // Send each agent's current now.md as the latest state.
      // (Helps after a restart where the JSONL might lag the now.md.)
      const agents = await listAgentSlugs();
      for (const agent of agents) {
        const evt = await readNow(agent);
        if (!evt) continue;
        const prior = lastLoggedTs.get(agent) ?? 0;
        if (evt.ts > prior) {
          lastLoggedTs.set(agent, evt.ts);
          safeEnqueue(sseFrame(JSON.stringify(evt)));
        }
      }

      const heartbeat = setInterval(() => {
        safeEnqueue(new TextEncoder().encode(": ping\n\n"));
      }, 15000);

      const watchers: FSWatcher[] = [];
      const emitTimers = new Map<string, NodeJS.Timeout>();

      const debouncedEmit = (agent: string) => {
        const key = agent;
        const prior = emitTimers.get(key);
        if (prior) clearTimeout(prior);
        const t = setTimeout(async () => {
          emitTimers.delete(key);
          const evt = await readNow(agent);
          if (!evt) return;
          if (!shouldEmit(evt)) return; // dedupe across leaked watchers
          await appendToFeedLog(evt);
          safeEnqueue(sseFrame(JSON.stringify(evt)));
        }, 150);
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
            if (!m) return;
            debouncedEmit(m[1]);
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
