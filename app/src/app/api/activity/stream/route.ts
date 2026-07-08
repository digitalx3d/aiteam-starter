import path from "node:path";
import { promises as fsp } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Team communication still lives at the aiTeam level (the shared inbox is the
// hub regardless of which agent/project you're working in). Per-agent files
// live at user level so any project on this machine can use them. Config is
// read per-connection: a settings change applies when the stream reconnects.
function sharedInboxPath(): string {
  return path.join(getConfig().aiteamDir, "inbox-shared.md");
}
function agentsDirPath(): string {
  return getConfig().agentsDir;
}

interface ActivityEvent {
  ts: number;
  path: string;
  rel: string;
  agent: string | null;
  kind: "shared-inbox" | "agent-inbox" | "agent-completed" | "other";
  preview?: string;
}

function classify(absPath: string): ActivityEvent | null {
  const norm = absPath.replace(/\\/g, "/");
  const agentsNorm = agentsDirPath().replace(/\\/g, "/");
  const sharedNorm = sharedInboxPath().replace(/\\/g, "/");

  if (norm === sharedNorm) {
    return {
      ts: Date.now(),
      path: absPath,
      rel: "inbox-shared.md",
      agent: null,
      kind: "shared-inbox",
    };
  }
  // <agents-dir>/<name>/<file>
  if (norm.startsWith(agentsNorm + "/")) {
    const rel = norm.slice(agentsNorm.length + 1);
    const m = rel.match(/^([^/]+)\/(inbox\.md|completed\.md)$/);
    if (m) {
      return {
        ts: Date.now(),
        path: absPath,
        rel: `agents/${rel}`,
        agent: m[1],
        kind: m[2] === "inbox.md" ? "agent-inbox" : "agent-completed",
      };
    }
  }
  return null;
}

async function readPreview(absPath: string): Promise<string | undefined> {
  try {
    const content = await fsp.readFile(absPath, "utf8");
    if (!content) return undefined;
    // Grab the last "## " section if present, else last 600 chars.
    const sections = content.split(/^## /m);
    const last = sections[sections.length - 1]?.trim();
    if (last && last.length > 0 && last.length < 1500) {
      return "## " + last;
    }
    const tail = content.slice(-600).trim();
    return tail.length > 0 ? tail : undefined;
  } catch {
    return undefined;
  }
}

function sseFrame(data: string): Uint8Array {
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

export async function GET(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Capture config at connect time; watchers live for the connection.
      const sharedInbox = sharedInboxPath();
      const agentsDir = agentsDirPath();
      let closed = false;
      const safeEnqueue = (frame: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(frame);
        } catch {
          closed = true;
        }
      };

      // Hello frame so the client knows the stream is live
      safeEnqueue(
        sseFrame(
          JSON.stringify({
            type: "hello",
            ts: Date.now(),
            watching: { sharedInbox, agentsDir },
          })
        )
      );

      // Heartbeat every 15s to keep proxies / dev servers from timing out
      const heartbeat = setInterval(() => {
        safeEnqueue(new TextEncoder().encode(": ping\n\n"));
      }, 15000);

      const watchers: FSWatcher[] = [];
      // Debounce emits per-file (fs.watch fires noisy duplicate events on Windows)
      const emitTimers = new Map<string, NodeJS.Timeout>();

      const debouncedEmit = (absPath: string) => {
        const prior = emitTimers.get(absPath);
        if (prior) clearTimeout(prior);
        const t = setTimeout(async () => {
          emitTimers.delete(absPath);
          const evt = classify(absPath);
          if (!evt) return;
          evt.preview = await readPreview(absPath);
          safeEnqueue(
            sseFrame(JSON.stringify({ type: "change", ...evt }))
          );
        }, 150);
        emitTimers.set(absPath, t);
      };

      try {
        // Shared inbox — single-file watch
        try {
          const w = watch(sharedInbox, { persistent: false }, () => {
            debouncedEmit(sharedInbox);
          });
          w.on("error", () => {});
          watchers.push(w);
        } catch {
          // file may not exist yet; ignore
        }

        // Agents dir — recursive watch (Node supports {recursive: true} on Windows + macOS)
        try {
          const w = watch(
            agentsDir,
            { persistent: false, recursive: true },
            (_eventType, filename) => {
              if (!filename) return;
              const abs = path.join(agentsDir, filename.toString());
              debouncedEmit(abs);
            }
          );
          w.on("error", () => {});
          watchers.push(w);
        } catch {
          // dir may not exist; ignore
        }
      } catch (err) {
        safeEnqueue(
          sseFrame(
            JSON.stringify({
              type: "error",
              ts: Date.now(),
              message: `failed to set up watchers: ${(err as Error).message}`,
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
