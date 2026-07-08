import {
  listTickets,
  subscribe,
  type DispatchTicket,
} from "@/lib/dispatch-store";
import {
  ensureVbNotifier,
  subscribeVbReply,
  type VbReplyEvent,
} from "@/lib/vb-notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseFrame(data: string): Uint8Array {
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

/**
 * GET /api/dispatch/events
 * SSE stream of dispatch lifecycle events. On connect, replays a snapshot of
 * recent tickets so the client can render existing state. Then pushes any new
 * ticket events as they happen.
 */
export async function GET(request: Request) {
  // First hit of this route per process boots the vb-notifier singleton.
  // It subscribes to the dispatch-store emitter and auto-pokes VB on
  // completions. Idempotent — only subscribes once even across many GETs.
  ensureVbNotifier();

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

      safeEnqueue(sseFrame(JSON.stringify({ type: "hello", ts: Date.now() })));

      // Snapshot replay: only open (queued/running) tickets. Terminal states
      // (done/failed/cancelled) are intentionally not replayed — they appear in
      // the chat once, at the moment they happen. Re-injecting them on every
      // reconnect would spam the dashboard with old completion bubbles.
      const snapshot = (await listTickets())
        .filter((t) => t.status === "queued" || t.status === "running")
        .slice(0, 50);
      for (const t of snapshot) {
        safeEnqueue(sseFrame(JSON.stringify({ type: "ticket", ticket: t })));
      }

      const unsubscribe = subscribe((t: DispatchTicket) => {
        safeEnqueue(sseFrame(JSON.stringify({ type: "ticket", ticket: t })));
      });

      const unsubscribeVbReply = subscribeVbReply((evt: VbReplyEvent) => {
        safeEnqueue(
          sseFrame(JSON.stringify({ type: "vb-reply", reply: evt }))
        );
      });

      const heartbeat = setInterval(() => {
        safeEnqueue(new TextEncoder().encode(": ping\n\n"));
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeVbReply();
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
