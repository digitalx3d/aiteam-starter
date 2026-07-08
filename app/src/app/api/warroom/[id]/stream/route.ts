import { getSession, subscribe, type WarRoomEvent } from "@/lib/warroom-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

function sseFrame(data: string): Uint8Array {
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

/**
 * GET /api/warroom/:id/stream
 * SSE stream of a War Room session. On connect, replays the session's existing
 * messages and current status, then live-streams new messages, typing
 * indicators, and status changes as the rounds run.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (frame: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(frame);
        } catch {
          closed = true;
        }
      };

      // Replay: session meta, then every existing message, then current status.
      safeEnqueue(
        sseFrame(
          JSON.stringify({
            type: "init",
            id: session.id,
            idea: session.idea,
            objective: session.objective,
            title: session.title,
            model: session.model,
            rounds: session.rounds,
            roster: session.rosterMeta,
          })
        )
      );
      for (const m of session.messages) {
        safeEnqueue(sseFrame(JSON.stringify({ type: "message", message: m })));
      }
      safeEnqueue(
        sseFrame(
          JSON.stringify({
            type: "status",
            status: session.status,
            currentRound: session.currentRound,
            savedPlanPath: session.savedPlanPath,
          })
        )
      );

      const unsubscribe = subscribe((sid: string, event: WarRoomEvent) => {
        if (sid !== id) return;
        safeEnqueue(sseFrame(JSON.stringify(event)));
      });

      const heartbeat = setInterval(() => {
        safeEnqueue(new TextEncoder().encode(": ping\n\n"));
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* noop */
        }
      };

      _request.signal.addEventListener("abort", cleanup);
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
