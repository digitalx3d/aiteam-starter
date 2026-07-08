import {
  getTicket,
  killTicketChild,
  updateTicket,
} from "@/lib/dispatch-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/** GET /api/dispatch/:id — fetch a single ticket. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const ticket = await getTicket(id);
  if (!ticket) {
    return new Response(JSON.stringify({ error: "ticket not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ticket }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * DELETE /api/dispatch/:id — cancel a running worker.
 * Kills the child process (if still alive) and marks the ticket cancelled.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const ticket = await getTicket(id);
  if (!ticket) {
    return new Response(JSON.stringify({ error: "ticket not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (ticket.status !== "running" && ticket.status !== "queued") {
    return new Response(
      JSON.stringify({ error: `ticket is ${ticket.status}, cannot cancel` }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  }
  const killed = killTicketChild(id);
  const updated = await updateTicket(id, {
    status: "cancelled",
    finishedAt: Date.now(),
    pid: null,
  });
  return new Response(
    JSON.stringify({ ticket: updated, killed }),
    { headers: { "Content-Type": "application/json" } }
  );
}
